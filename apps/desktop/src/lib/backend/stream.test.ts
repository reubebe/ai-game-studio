import { expect, it, vi } from "vitest";
import type { GenerateResult, StreamEvent } from "./types";

// A backend that streams half an answer, asks again (as the Rust side does when Gemini breaks off
// partway because it is overloaded), then streams the whole answer.
const listeners: ((e: StreamEvent) => void)[] = [];
vi.mock("./index", () => ({
  backend: {
    listenAiStream: async (listener: (e: StreamEvent) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    aiStreamStart: async (streamId: string) => {
      const whole = '{"reply": "Whole"}';
      const result: GenerateResult = { provider: "gemini", model: "gemini-flash-lite-latest", text: whole, inputTokens: 5, outputTokens: 3, servedBy: null, notes: [], durationMs: 1 };
      const events: Omit<StreamEvent, "streamId">[] = [{ kind: "delta", text: '{"reply": "Ha' }, { kind: "restart" }, { kind: "delta", text: '{"reply": ' }, { kind: "delta", text: '"Whole"}' }, { kind: "done", result }];
      queueMicrotask(() => events.forEach((e) => [...listeners].forEach((l) => l({ streamId, ...e }))));
    },
    aiStreamStop: async () => true,
  },
}));

const { streamGenerate } = await import("./stream");

it("clears the text shown so far when the provider is asked again", async () => {
  let shown = "";
  let restarts = 0;
  const stream = streamGenerate({ provider: "gemini", model: "gemini-flash-lite-latest", system: "s", messages: [], schema: {}, schemaName: "reply" }, null, (piece) => (shown += piece), () => {
    restarts += 1;
    shown = "";
  });
  const result = await stream.result;
  expect(restarts).toBe(1);
  expect(shown).toBe(result.text);
  expect(listeners).toHaveLength(0);
});
