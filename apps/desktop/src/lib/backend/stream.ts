import { backend } from "./index";
import type { GenerateRequest, GenerateResult } from "./types";

/**
 * Streams one reply: `onText` receives each new piece of text as it arrives, `onRestart` says the text
 * so far no longer counts (the provider broke the answer off and the backend is asking again), `result`
 * settles with the finished reply (or the reason it stopped), and `stop()` ends it early.
 */
export function streamGenerate(request: GenerateRequest, project: string | null, onText: (piece: string) => void, onRestart?: () => void): { result: Promise<GenerateResult>; stop: () => void } {
  const streamId = crypto.randomUUID();
  let stopped = false;
  const result = (async () => {
    let unlisten: () => void = () => {};
    try {
      const done = new Promise<GenerateResult>((resolve, reject) => {
        void backend
          .listenAiStream((e) => {
            if (e.streamId !== streamId) return;
            if (e.kind === "delta" && e.text) onText(e.text);
            else if (e.kind === "restart") onRestart?.();
            else if (e.kind === "done" && e.result) resolve(e.result);
            else if (e.kind === "error") reject(new Error(e.message ?? "The reply stopped."));
          })
          .then((u) => {
            unlisten = u;
            if (stopped) return reject(new Error("Stopped."));
            return backend.aiStreamStart(streamId, request, project);
          })
          .catch(reject);
      });
      return await done;
    } finally {
      unlisten();
    }
  })();
  return {
    result,
    stop: () => {
      stopped = true;
      void backend.aiStreamStop(streamId);
    },
  };
}
