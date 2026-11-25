// @vitest-environment jsdom
// The runs store loads the backend, which looks at window to choose the Tauri or browser backend.
import { describe, expect, it } from "vitest";
import { plainText, useRuns } from "./runs";

describe("runs", () => {
  it("shows Godot's coloured export log as plain text", () => {
    expect(plainText("[  6% ] \x1b[90m\x1b[1msavepack\x1b[22m | Storing File: res://icon.svg.import\x1b[39m\x1b[0m")).toBe("[  6% ] savepack | Storing File: res://icon.svg.import");
    expect(plainText("no codes here")).toBe("no codes here");
  });

  it("feeds a game playing here into a run: output, telemetry with the player's position, and its end", () => {
    const { startLocal, append, finishLocal } = useRuns.getState();
    const id = startLocal("Playing here");
    append(id, "studio", "▸ exports/web/index.html");
    append(id, "stdout", "Godot Engine v4.7.2");
    append(id, "stdout", 'GSTUDIO {"drawCalls":149.0,"fps":60.0,"memoryMb":31.1,"nodes":133.0,"physicsMs":0.3,"player":[0.0,0.0,20.5],"processMs":2.0,"type":"perf"}');
    append(id, "stdout", 'GSTUDIO {"type":"perf","fps":59,"player":[1,"x",2]}');
    append(id, "stderr", "\x1b[31mERROR\x1b[0m: something");
    let run = useRuns.getState().runs.find((r) => r.id === id)!;
    expect(run.action).toBe("play-here");
    expect(run.status).toBe("running");
    expect(run.perf.map((p) => [p.fps, p.drawCalls, p.player ?? null])).toEqual([[60, 149, [0, 0, 20.5]], [59, 0, null]]);
    expect(run.lines.map((l) => l.text)).toContain("ERROR: something");
    finishLocal(id, "stopped", "Stopped.");
    finishLocal(id, "failed", "ignored: already over");
    run = useRuns.getState().runs.find((r) => r.id === id)!;
    expect(run.status).toBe("stopped");
    expect(run.lines.at(-1)?.text).toBe("Stopped.");
  });
});
