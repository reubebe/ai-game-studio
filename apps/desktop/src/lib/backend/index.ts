import type { Backend } from "./types";
import { createBrowserBackend } from "./browser";
import { createTauriBackend } from "./tauri";

export * from "./types";

function detect(): Backend {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  return w.__TAURI_INTERNALS__ ? createTauriBackend() : createBrowserBackend();
}

export const backend: Backend = detect();
