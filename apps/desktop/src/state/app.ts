import { create } from "zustand";
import { backend, errorMessage, type AppInfo, type Settings } from "../lib/backend";

export type Route = "home" | "workspace" | "play" | "assets" | "assistant" | "engines" | "plugins" | "settings";
export type Mode = "creator" | "designer" | "developer";

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  detail?: string;
}

export type Dialog =
  | { kind: "new-project"; templateId?: string }
  | { kind: "idea" }
  | { kind: "snapshot" }
  | { kind: "confirm"; title: string; body: string; details?: string[]; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>; onCancel?: () => void };

interface AppStore {
  info: AppInfo | null;
  settings: Settings;
  route: Route;
  mode: Mode;
  toasts: Toast[];
  dialog: Dialog | null;
  boot: () => Promise<void>;
  setRoute: (r: Route) => void;
  setMode: (m: Mode) => void;
  setSetting: (key: string, value: unknown) => Promise<boolean>;
  toast: (kind: Toast["kind"], title: string, detail?: string) => void;
  dismiss: (id: number) => void;
  openDialog: (d: Dialog) => void;
  closeDialog: () => void;
}

let toastId = 0;

export const useApp = create<AppStore>((set, get) => ({
  info: null,
  settings: {},
  route: "home",
  mode: "designer",
  toasts: [],
  dialog: null,
  boot: async () => {
    const [info, settings] = await Promise.all([backend.appInfo(), backend.settingsGet()]);
    const saved = settings["ui.mode"];
    set({ info, settings, mode: saved === "creator" || saved === "designer" || saved === "developer" ? saved : "designer" });
  },
  setRoute: (route) => set({ route }),
  setMode: (mode) => {
    set({ mode });
    void get().setSetting("ui.mode", mode);
  },
  setSetting: async (key, value) => {
    try {
      const settings = await backend.settingsSet(key, value);
      set({ settings });
      return true;
    } catch (e) {
      get().toast("error", "Setting not saved", errorMessage(e));
      return false;
    }
  },
  toast: (kind, title, detail) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, title, ...(detail ? { detail } : {}) }] }));
    window.setTimeout(() => get().dismiss(id), kind === "error" ? 9000 : kind === "success" ? 3000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
}));
