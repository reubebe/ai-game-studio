import { describe, expect, it } from "vitest";
import { coreDomain, createRegistry, compileGraph, compileOrThrow, RuleRuntime } from "@gamestudio/rules-core";
import { cupRules, footballDomain, FootballSimHost, FORMATIONS, harbourCup, parseMatch, SQUAD_SIZE } from "./index";

const registry = createRegistry([coreDomain, footballDomain]);

function play(match = harbourCup()) {
  const runtime = new RuleRuntime(compileOrThrow(cupRules(), registry));
  const host = new FootballSimHost(match);
  const messages = () => host.effects.filter((e) => e.type === "message").map((e) => (e as { text: string }).text);
  const fullTime = () => {
    host.runOut();
    const r = runtime.run("fullTime", {}, host);
    expect(r.error).toBeUndefined();
  };
  return { runtime, host, messages, fullTime };
}

describe("match settings", () => {
  it("validates the Harbour Cup Final and its squads", () => {
    const r = parseMatch(harbourCup());
    expect(r.ok).toBe(true);
    const m = harbourCup();
    for (const side of ["home", "away"] as const) {
      expect(m[side].players).toHaveLength(SQUAD_SIZE);
      expect(new Set(m[side].players.map((p) => p.number)).size).toBe(SQUAD_SIZE);
    }
  });

  it("refuses repeated shirt numbers, a goal too wide for the pitch, the same short names and skills out of range", () => {
    const twice = harbourCup();
    twice.home.players[2]!.number = twice.home.players[1]!.number;
    expect(parseMatch(twice)).toMatchObject({ ok: false });
    expect(!parseMatch(twice).ok && (parseMatch(twice) as { errors: string[] }).errors.join(" ")).toMatch(/used twice/);
    const wide = harbourCup();
    wide.pitch.goalWidth = 7;
    wide.pitch.width = 12;
    expect(parseMatch(wide).ok).toBe(false);
    const same = harbourCup();
    same.away.short = same.home.short;
    expect(parseMatch(same).ok).toBe(false);
    const fast = harbourCup();
    fast.home.players[0]!.pace = 11;
    expect(parseMatch(fast).ok).toBe(false);
    const short = harbourCup();
    short.home.players = short.home.players.slice(0, 4);
    expect(parseMatch(short).ok).toBe(false);
  });

  it("lets older settings without a control field default to the home team", () => {
    const { control: _c, ...rest } = harbourCup();
    const r = parseMatch(rest);
    expect(r.ok && r.match.control).toBe("home");
  });

  it("has a kick-off spot for every player of every team size, keeper first, inside the team's half", () => {
    for (let size = 2; size <= 5; size++) {
      const spots = FORMATIONS[size]!;
      expect(spots, String(size)).toHaveLength(size);
      expect(spots[0]!.x).toBeLessThan(0.1);
      for (const s of spots) {
        expect(s.x).toBeGreaterThan(0);
        expect(s.x).toBeLessThanOrEqual(1);
        expect(Math.abs(s.z)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("Harbour Cup rules", () => {
  it("compile cleanly", () => {
    expect(compileGraph(cupRules(), registry).diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  it("announce each goal with the scorer, the team and the score", () => {
    const { runtime, host, messages } = play();
    runtime.run("start", {}, host);
    expect(host.caption).toBe("Win the Harbour Cup!");
    runtime.run("goal", host.goal("home", 4), host);
    runtime.run("goal", host.goal("away", 3), host);
    expect(messages().slice(1)).toEqual(["GOAL! Kofi Antwi for Harbour Lions  1 – 0", "GOAL! Yaw Ansah for Hilltop Rovers  1 – 1"]);
    expect(host.effects.filter((e) => e.type === "sound").map((e) => (e as { sound: string }).sound)).toEqual(["whistle", "goal", "goal"]);
  });

  it("warn in the last minute only", () => {
    const { runtime, host, messages } = play();
    for (let i = 0; i < 3; i++) {
      const minute = host.nextMinute();
      runtime.run("minute", { minute: minute! }, host);
    }
    expect(messages()).toEqual(["Last minute!"]);
    expect(host.nextMinute()).toBeNull();
  });

  it("give the cup to the side ahead at full time", () => {
    const { runtime, host, fullTime } = play();
    runtime.run("goal", host.goal("away"), host);
    fullTime();
    expect(host.ended).toBe("Full time: Hilltop Rovers win the Harbour Cup.");
  });

  it("play a golden-goal minute when level, won by the next goal", () => {
    const { runtime, host, fullTime } = play();
    fullTime();
    expect(host.ended).toBeNull();
    expect(host.secondsLeft).toBe(60);
    expect(host.caption).toBe("Golden goal: the next goal wins!");
    runtime.run("goal", host.goal("home", 3), host);
    expect(host.ended).toBe("Golden goal! Harbour Lions win the Harbour Cup!");
  });

  it("share the cup when the golden-goal minute ends level", () => {
    const { host, fullTime } = play();
    fullTime();
    fullTime();
    expect(host.ended).toBe("Full time: still level after the golden goal. The cup is shared!");
  });

  it("follow the settings: renamed teams and players appear in the announcements", () => {
    const m = harbourCup();
    m.home.name = "Coast Comets";
    m.home.players[4]!.name = "Abena Quaye";
    const { runtime, host, messages } = play(m);
    runtime.run("goal", host.goal("home"), host);
    expect(messages()).toEqual(["GOAL! Abena Quaye for Coast Comets  1 – 0"]);
  });
});

describe("the simulator stand-in", () => {
  it("keeps the score, refuses unknown teams and ends with the score when no rule decides", () => {
    const host = new FootballSimHost(harbourCup());
    host.call("football.changeScore", { team: "away", amount: 2 });
    expect(host.query("football.score", { team: "away" })).toBe(2);
    expect(() => host.query("football.score", { team: "visitors" })).toThrow(/home or away/);
    host.call("football.addTime", { seconds: 30 });
    expect(host.query("football.timeLeft", {})).toBe(270);
    expect(host.defaultResult()).toBe("Full time: Hilltop Rovers win 2 – 0");
    expect(host.lineUp("home").map((p) => p.number)).toEqual([1, 4, 5, 8, 9]);
    const three = new FootballSimHost({ ...harbourCup(), teamSize: 3 });
    expect(three.lineUp("away").map((p) => p.name)).toEqual(["Lars Brekke", "Ama Sarpong", "Diego Varela"]);
    expect(() => three.goal("away", 4)).toThrow(/no player 4/);
  });
});
