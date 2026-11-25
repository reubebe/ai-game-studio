import { create } from "zustand";
import { backend, errorMessage, type EngineReport, type ProviderStatus } from "../lib/backend";

interface EnvStore {
  engines: EngineReport[] | null;
  providers: ProviderStatus[] | null;
  engineError: string | null;
  loadingEngines: boolean;
  refreshEngines: () => Promise<void>;
  refreshProviders: () => Promise<void>;
}

export const useEnv = create<EnvStore>((set) => ({
  engines: null,
  providers: null,
  engineError: null,
  loadingEngines: false,
  refreshEngines: async () => {
    set({ loadingEngines: true });
    try {
      set({ engines: await backend.enginesDiscover(), engineError: null });
    } catch (e) {
      set({ engineError: errorMessage(e) });
    } finally {
      set({ loadingEngines: false });
    }
  },
  refreshProviders: async () => {
    try {
      set({ providers: await backend.aiProviders() });
    } catch {
      set({ providers: [] });
    }
  },
}));

/** The Unity editor a project should use: its exact version when installed, else none. */
export function unityInstall(engines: EngineReport[] | null, version?: string) {
  const unity = engines?.find((e) => e.id === "unity");
  if (version) return unity?.installs.find((i) => i.version === version) ?? null;
  return unity?.installs.find((i) => i.compatible) ?? unity?.installs[0] ?? null;
}

/** The Unreal Engine install a project should use: its exact version when installed, else none. */
export function unrealInstall(engines: EngineReport[] | null, version?: string) {
  const unreal = engines?.find((e) => e.id === "unreal");
  if (version) return unreal?.installs.find((i) => i.version === version) ?? null;
  return unreal?.installs[unreal.installs.length - 1] ?? null;
}

export function godotInstall(engines: EngineReport[] | null) {
  const godot = engines?.find((e) => e.id === "godot");
  return godot?.installs.find((i) => i.source === "configured") ?? godot?.installs.find((i) => i.compatible) ?? godot?.installs[0] ?? null;
}
