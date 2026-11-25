import { baseManifest, finalize, type GenerateOptions, type GeneratedProject } from "./common";
import { generateExploration, GODOT_DIR } from "./exploration";

const XR_FILES = import.meta.glob("../../../../templates/xr-foundation/godot/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// startup_alert=false: without an OpenXR runtime, Godot's startup alert is a modal dialog that blocks even
// headless runs (verified with 4.7.2 on macOS). The XR scene reports the fallback itself instead.
export const XR_SETTINGS = "\n[xr]\n\nopenxr/enabled=true\nopenxr/startup_alert=false\nshaders/enabled=true\n";

export function xrChecklist(title: string): string {
  return `# XR checklist: ${title}

Status: **foundation, not verified on a headset.** Game Studio generated these files; nothing here has
been run on XR hardware by the studio.

| Item | Current value | Verified |
|---|---|---|
| Engine | Godot 4.7.2 with OpenXR enabled in project settings | Settings written; no device test |
| Entry scene | \`res://scenes/xr_main.tscn\` (desktop play stays in \`scenes/main.tscn\`) | No |
| Runtime | Any OpenXR runtime (for example Meta Quest Link or SteamVR) | No |
| Input | Default Godot OpenXR action map: left stick moves, right stick snap-turns 30 degrees | No |
| Comfort | Snap turning on; no vignette yet | No |
| Interaction toolkit | Godot XR Tools is **not installed** (adding it is a separate, approved download) | n/a |
| Gameplay | Collecting, gates and rules run only in the desktop scene for now | n/a |

Before claiming XR support: install an OpenXR runtime, run \`xr_main.tscn\` on the target headset, record
the device, runtime version, frame rate and comfort observations here.
`;
}

export function generateXr(o: GenerateOptions): GeneratedProject {
  const base = generateExploration(o);
  const manifest = baseManifest(o, {
    ...base.manifest,
    template: { id: "xr-foundation", version: "1.0.0" },
    genre: [...base.manifest.genre, "xr"],
    modules: [...base.manifest.modules, "xr.openxr"],
    xr: { enabled: true, runtime: "openxr", targets: ["OpenXR-compatible headset"], comfort: { snapTurn: true, vignette: false }, verifiedOnHeadset: false },
  });
  const files = base.files
    .filter((f) => f.path !== "gamestudio.json")
    .map((f) => (f.path === `${GODOT_DIR}/project.godot` ? { ...f, content: f.content + XR_SETTINGS } : f));
  for (const [key, content] of Object.entries(XR_FILES)) {
    const rel = key.split("/templates/xr-foundation/godot/")[1];
    if (rel) files.push({ path: `${GODOT_DIR}/${rel}`, content });
  }
  files.push({ path: "gamestudio.json", content: JSON.stringify(manifest, null, 2) + "\n" });
  files.push({ path: "docs/xr-checklist.md", content: xrChecklist(manifest.title) });
  return finalize(manifest, files);
}
