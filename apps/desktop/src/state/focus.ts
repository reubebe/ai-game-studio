import { create } from "zustand";

/** Cross-view requests such as "show node X in this graph" from the Problems list. */
export interface FocusRequest {
  path: string;
  nodeId?: string;
  objectId?: string;
  seq: number;
}

let seq = 0;
export const useFocus = create<{ request: FocusRequest | null; focus: (path: string, opts?: { nodeId?: string; objectId?: string }) => void }>((set) => ({
  request: null,
  focus: (path, opts) => set({ request: { path, ...opts, seq: ++seq } }),
}));
