import { describe, expect, it } from "vitest";
import { readCfg, setCfgValue } from "./cfg";

describe("game.cfg editing", () => {
  it("updates values in place and keeps comments and unknown lines", () => {
    const text = "# settings\nplayer_speed = 420\ncustom = yes\nlives = 3\n";
    const next = setCfgValue(setCfgValue(text, "lives", 5), "target_score", 30);
    expect(next).toBe("# settings\nplayer_speed = 420\ncustom = yes\nlives = 5\ntarget_score = 30\n");
    expect(readCfg(next)).toEqual({ player_speed: 420, lives: 5, target_score: 30 });
  });
});
