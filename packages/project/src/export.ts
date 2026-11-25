import type { ProjectManifest } from "./manifest";

/** Exported builds live here, outside the engine folder and out of snapshots (see .gitignore). */
export const EXPORTS_DIR = "exports";
export const MACOS_EXPORT_DIR = `${EXPORTS_DIR}/macos`;
export const MACOS_PRESET_NAME = "macOS";
/** The web build that Play here shows inside Game Studio. */
export const WEB_EXPORT_DIR = `${EXPORTS_DIR}/web`;
export const WEB_PRESET_NAME = "Web";
/** Godot refuses universal and arm64 macOS exports unless this texture format is imported. */
export const ETC2_ASTC_SETTING = "textures/vram_compression/import_etc2_astc";
/** Windows and Linux builds: a 64-bit x86 program with the game's data in a .pck beside it. */
export const WINDOWS_EXPORT_DIR = `${EXPORTS_DIR}/windows`;
export const LINUX_EXPORT_DIR = `${EXPORTS_DIR}/linux`;
export type DesktopTarget = "windows" | "linux";
/**
 * Each desktop target: the button's name for it, the studio's preset, the platform names Godot writes for it
 * (Linux was "Linux/X11" before Godot 4.2), where its build goes, the program's suffix in the studio's preset, and
 * the suffix a user's own preset must keep (none for Linux, whose programs may have any name).
 */
export const DESKTOP_TARGETS: Record<DesktopTarget, { label: string; presetName: string; platforms: readonly string[]; dir: string; suffix: string; required: string }> = {
  windows: { label: "Windows", presetName: "Windows", platforms: ["Windows Desktop"], dir: WINDOWS_EXPORT_DIR, suffix: ".exe", required: ".exe" },
  linux: { label: "Linux", presetName: "Linux", platforms: ["Linux", "Linux/X11"], dir: LINUX_EXPORT_DIR, suffix: ".x86_64", required: "" },
};

/** A file and folder name for the exported app: letters, digits, spaces and . _ ( ) - only. */
export function exportAppName(title: string): string {
  const cleaned = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ._()-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 60)
    .trim();
  return cleaned || "Game";
}

/** Reverse-DNS bundle identifier; every segment starts with a letter. */
export function bundleIdFor(projectId: string): string {
  const slug = projectId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `com.gamestudio.${/^[a-z]/.test(slug) ? slug : `game-${slug}`}`;
}

function cfgString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function readCfgString(raw: string): string {
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(raw.trim());
  return m ? m[1]!.replace(/\\(.)/g, "$1") : raw.trim();
}

/** A path under the project root, written relative to the Godot project folder (Godot resolves export paths from there). */
function fromGodotDir(manifest: ProjectManifest, path: string): string {
  const dir = "projectDir" in manifest.engine ? manifest.engine.projectDir : ".";
  const up = dir.split("/").filter((part) => part && part !== ".").map(() => "..").join("/");
  return `${up ? `${up}/` : ""}${path}`;
}

/** Path of the macOS build relative to the Godot project folder (Godot resolves it from there). */
export function macExportPath(manifest: ProjectManifest): string {
  return fromGodotDir(manifest, `${MACOS_EXPORT_DIR}/${exportAppName(manifest.title)}.app`);
}

/** Path of the web build's page relative to the Godot project folder (Godot resolves it from there). */
export function webExportPath(manifest: ProjectManifest): string {
  return fromGodotDir(manifest, `${WEB_EXPORT_DIR}/index.html`);
}

/** Path of a Windows or Linux build's program relative to the Godot project folder. */
export function desktopExportPath(manifest: ProjectManifest, target: DesktopTarget): string {
  const t = DESKTOP_TARGETS[target];
  return fromGodotDir(manifest, `${t.dir}/${exportAppName(manifest.title)}${t.suffix}`);
}

/**
 * A Godot 4.7 web export preset for Play here: single-threaded, so it runs without cross-origin isolation
 * (SharedArrayBuffer), with desktop texture compression and the canvas sized to its frame. `index` is the
 * preset's number in export_presets.cfg.
 */
export function godotWebPreset(manifest: ProjectManifest, index: number): string {
  return [
    `[preset.${index}]`,
    "",
    `name="${WEB_PRESET_NAME}"`,
    'platform="Web"',
    "runnable=true",
    "dedicated_server=false",
    'custom_features=""',
    'export_filter="all_resources"',
    'include_filter="*.json"',
    'exclude_filter="addons/gamestudio_runtime/tests/*"',
    `export_path="${cfgString(webExportPath(manifest))}"`,
    "",
    `[preset.${index}.options]`,
    "",
    "variant/extensions_support=false",
    "variant/thread_support=false",
    "vram_texture_compression/for_desktop=true",
    "vram_texture_compression/for_mobile=false",
    "html/canvas_resize_policy=2",
    "html/focus_canvas_on_start=true",
    "progressive_web_app/enabled=false",
    "",
  ].join("\n");
}

/**
 * A Godot 4.7 export preset for a 64-bit x86 Windows or Linux build, with the game's data in a .pck beside the
 * program. Godot writes the Windows icon and version details itself (no rcedit or Wine needed); the .exe is not
 * code-signed. `index` is the preset's number in export_presets.cfg.
 */
export function godotDesktopPreset(manifest: ProjectManifest, target: DesktopTarget, index: number): string {
  const t = DESKTOP_TARGETS[target];
  return [
    `[preset.${index}]`,
    "",
    `name="${t.presetName}"`,
    `platform="${t.platforms[0]}"`,
    "runnable=true",
    "dedicated_server=false",
    'custom_features=""',
    'export_filter="all_resources"',
    'include_filter="*.json"',
    'exclude_filter="addons/gamestudio_runtime/tests/*"',
    `export_path="${cfgString(desktopExportPath(manifest, target))}"`,
    "",
    `[preset.${index}.options]`,
    "",
    'binary_format/architecture="x86_64"',
    "binary_format/embed_pck=false",
    "",
  ].join("\n");
}

/** export_presets.cfg for a new Godot project: macOS, Windows and Linux builds (the Export buttons) and the web build (Play here). */
export function godotPresets(manifest: ProjectManifest): string {
  return [godotMacPreset(manifest), godotWebPreset(manifest, 1), godotDesktopPreset(manifest, "windows", 2), godotDesktopPreset(manifest, "linux", 3)].join("\n");
}

/** A Godot 4.7 export preset for a universal macOS app, ad-hoc signed, not notarized. */
export function godotMacPreset(manifest: ProjectManifest): string {
  return [
    "; Created by Universal AI Game Studio for its Export buttons and Play here. Godot's Export dialog can edit it.",
    "",
    "[preset.0]",
    "",
    `name="${MACOS_PRESET_NAME}"`,
    'platform="macOS"',
    "runnable=true",
    "dedicated_server=false",
    'custom_features=""',
    'export_filter="all_resources"',
    'include_filter="*.json"',
    'exclude_filter="addons/gamestudio_runtime/tests/*"',
    `export_path="${cfgString(macExportPath(manifest))}"`,
    "",
    "[preset.0.options]",
    "",
    'binary_format/architecture="universal"',
    `application/bundle_identifier="${bundleIdFor(manifest.projectId)}"`,
    "codesign/codesign=1",
    "",
  ].join("\n");
}

export interface GodotPreset {
  name: string;
  platform: string;
  exportPath: string;
}

/** Presets declared in export_presets.cfg (Godot's ConfigFile text format). */
export function parseGodotPresets(cfg: string): GodotPreset[] {
  const presets: GodotPreset[] = [];
  let current: GodotPreset | null = null;
  for (const raw of cfg.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      current = /^\[preset\.\d+\]$/.test(line) ? { name: "", platform: "", exportPath: "" } : null;
      if (current) presets.push(current);
      continue;
    }
    if (!current || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = readCfgString(line.slice(eq + 1));
    if (key === "name") current.name = value;
    else if (key === "platform") current.platform = value;
    else if (key === "export_path") current.exportPath = value;
  }
  return presets;
}

/** Turn on ETC2/ASTC import in project.godot, keeping everything else as written. */
export function enableEtc2Astc(projectGodot: string): string {
  const setting = new RegExp(`^${ETC2_ASTC_SETTING.replace(/\//g, "\\/")}\\s*=.*$`, "m");
  if (setting.test(projectGodot)) return projectGodot.replace(setting, `${ETC2_ASTC_SETTING}=true`);
  const lines = projectGodot.split("\n");
  const header = lines.findIndex((l) => l.trim() === "[rendering]");
  if (header < 0) return `${projectGodot.replace(/\n*$/, "\n")}\n[rendering]\n\n${ETC2_ASTC_SETTING}=true\n`;
  lines.splice(header + 1, lines[header + 1]?.trim() === "" ? 1 : 0, "", `${ETC2_ASTC_SETTING}=true`);
  return lines.join("\n");
}

export function etc2AstcEnabled(projectGodot: string): boolean {
  return new RegExp(`^${ETC2_ASTC_SETTING.replace(/\//g, "\\/")}\\s*=\\s*true\\s*$`, "m").test(projectGodot);
}

export interface ExportPlan {
  /** Files to write before exporting; empty when the project is already set up. */
  writes: { path: string; content: string }[];
  /** Plain-language description of each change, for the confirmation dialog. */
  changes: string[];
  /** The macOS build, relative to the project root. */
  appPath: string | null;
  problem: string | null;
}

function normalize(parts: string[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}

/**
 * What a macOS export needs from a Godot project: a macOS preset, ETC2/ASTC textures and an
 * ignored exports folder. Existing presets are kept; a project without one gets the studio's.
 */
export function planGodotExport(input: { manifest: ProjectManifest; presets: string | null; projectGodot: string; gitignore: string | null }): ExportPlan {
  const { manifest } = input;
  if (manifest.engine.id !== "godot") return { writes: [], changes: [], appPath: null, problem: "Only Godot projects export from here." };
  const dir = manifest.engine.projectDir;
  const writes: ExportPlan["writes"] = [];
  const changes: string[] = [];
  let preset = input.presets ? parseGodotPresets(input.presets).find((p) => p.platform === "macOS") : undefined;
  if (input.presets !== null && !preset) {
    return { writes: [], changes: [], appPath: null, problem: `${dir}/export_presets.cfg has no macOS preset. Add one in Godot's Export dialog, or delete the file to let Game Studio create it.` };
  }
  if (!preset) {
    const text = godotMacPreset(manifest);
    writes.push({ path: `${dir}/export_presets.cfg`, content: text });
    changes.push(`Create ${dir}/export_presets.cfg with a macOS preset (universal app, ad-hoc signed, not notarized).`);
    preset = parseGodotPresets(text)[0]!;
  }
  if (!preset.exportPath || preset.exportPath.startsWith("/") || preset.exportPath.includes("\\") || !preset.exportPath.endsWith(".app")) {
    return { writes: [], changes: [], appPath: null, problem: `The macOS preset must export to a .app inside the project folder (it says "${preset.exportPath}").` };
  }
  const appPath = normalize([...dir.split("/"), ...preset.exportPath.split("/")]);
  if (!appPath) return { writes: [], changes: [], appPath: null, problem: "The macOS preset's export path leaves the project folder." };
  if (!etc2AstcEnabled(input.projectGodot)) {
    writes.push({ path: `${dir}/project.godot`, content: enableEtc2Astc(input.projectGodot) });
    changes.push(`Turn on ETC2/ASTC texture import in ${dir}/project.godot. Godot needs it for Apple Silicon builds.`);
  }
  const ignore = input.gitignore ?? "";
  if (!ignore.split(/\r?\n/).some((l) => l.trim() === `${EXPORTS_DIR}/` || l.trim() === `/${EXPORTS_DIR}/`)) {
    writes.push({ path: ".gitignore", content: `${ignore.replace(/\n*$/, ignore ? "\n" : "")}${EXPORTS_DIR}/\n` });
    changes.push(`Add ${EXPORTS_DIR}/ to .gitignore so builds stay out of snapshots.`);
  }
  return { writes, changes, appPath, problem: null };
}

export interface WebExportPlan {
  /** Files to write before exporting; empty when the project is already set up. */
  writes: { path: string; content: string }[];
  /** Plain-language description of each change, for the confirmation dialog. */
  changes: string[];
  /** The web build's page, relative to the project root. */
  pagePath: string | null;
  problem: string | null;
}

/** The number after the last [preset.N] section, for appending a preset. */
function nextPresetIndex(cfg: string): number {
  let max = -1;
  for (const m of cfg.matchAll(/^\s*\[preset\.(\d+)\]\s*$/gm)) max = Math.max(max, Number(m[1]));
  return max + 1;
}

/**
 * What Play here needs from a Godot project: a Web preset that exports inside the project folder, and an
 * ignored exports folder. A user's own Web preset is kept; a project without one gets the studio's,
 * appended after its other presets.
 */
export function planGodotWebExport(input: { manifest: ProjectManifest; presets: string | null; gitignore: string | null }): WebExportPlan {
  const { manifest } = input;
  const none = (problem: string): WebExportPlan => ({ writes: [], changes: [], pagePath: null, problem });
  if (manifest.engine.id !== "godot") return none("Only Godot projects play here.");
  const dir = manifest.engine.projectDir;
  const writes: WebExportPlan["writes"] = [];
  const changes: string[] = [];
  let preset = input.presets ? parseGodotPresets(input.presets).find((p) => p.platform === "Web") : undefined;
  if (!preset) {
    const text = godotWebPreset(manifest, input.presets ? nextPresetIndex(input.presets) : 0);
    if (input.presets) {
      writes.push({ path: `${dir}/export_presets.cfg`, content: `${input.presets.replace(/\n*$/, "\n")}\n${text}` });
      changes.push(`Add a Web preset to ${dir}/export_presets.cfg: a single-threaded build in ${WEB_EXPORT_DIR}/ that Play here shows. Your other presets stay as they are.`);
    } else {
      writes.push({ path: `${dir}/export_presets.cfg`, content: `; Created by Universal AI Game Studio for Play here. Godot's Export dialog can edit it.\n\n${text}` });
      changes.push(`Create ${dir}/export_presets.cfg with a Web preset: a single-threaded build in ${WEB_EXPORT_DIR}/ that Play here shows.`);
    }
    preset = parseGodotPresets(text)[0]!;
  }
  if (!preset.exportPath || preset.exportPath.startsWith("/") || preset.exportPath.includes("\\") || !preset.exportPath.endsWith(".html")) {
    return none(`The Web preset must export to an .html page inside the project folder (it says "${preset.exportPath}").`);
  }
  const pagePath = normalize([...dir.split("/"), ...preset.exportPath.split("/")]);
  if (!pagePath) return none("The Web preset's export path leaves the project folder.");
  const ignore = input.gitignore ?? "";
  if (!ignore.split(/\r?\n/).some((l) => l.trim() === `${EXPORTS_DIR}/` || l.trim() === `/${EXPORTS_DIR}/`)) {
    writes.push({ path: ".gitignore", content: `${ignore.replace(/\n*$/, ignore ? "\n" : "")}${EXPORTS_DIR}/\n` });
    changes.push(`Add ${EXPORTS_DIR}/ to .gitignore so builds stay out of snapshots.`);
  }
  return { writes, changes, pagePath, problem: null };
}

export interface DesktopExportPlan {
  /** Files to write before exporting; empty when the project is already set up. */
  writes: { path: string; content: string }[];
  /** Plain-language description of each change, for the confirmation dialog. */
  changes: string[];
  /** The build's program, relative to the project root. Its game data is the .pck of the same name beside it. */
  buildPath: string | null;
  problem: string | null;
}

/**
 * What a Windows or Linux export needs from a Godot project: a preset for that platform that exports inside the
 * project folder, and an ignored exports folder. A user's own preset is kept; a project without one gets the
 * studio's, appended after its other presets.
 */
export function planGodotDesktopExport(input: { manifest: ProjectManifest; target: DesktopTarget; presets: string | null; gitignore: string | null }): DesktopExportPlan {
  const { manifest, target } = input;
  const t = DESKTOP_TARGETS[target];
  const none = (problem: string): DesktopExportPlan => ({ writes: [], changes: [], buildPath: null, problem });
  if (manifest.engine.id !== "godot") return none("Only Godot projects export from here.");
  const dir = manifest.engine.projectDir;
  const writes: DesktopExportPlan["writes"] = [];
  const changes: string[] = [];
  let preset = input.presets ? parseGodotPresets(input.presets).find((p) => t.platforms.includes(p.platform)) : undefined;
  if (!preset) {
    const text = godotDesktopPreset(manifest, target, input.presets ? nextPresetIndex(input.presets) : 0);
    const what = `a ${t.label} preset: a 64-bit build in ${t.dir}/ with the game's data in a .pck beside it`;
    if (input.presets) {
      writes.push({ path: `${dir}/export_presets.cfg`, content: `${input.presets.replace(/\n*$/, "\n")}\n${text}` });
      changes.push(`Add ${what} to ${dir}/export_presets.cfg. Your other presets stay as they are.`);
    } else {
      writes.push({ path: `${dir}/export_presets.cfg`, content: `; Created by Universal AI Game Studio for Export for ${t.label}. Godot's Export dialog can edit it.\n\n${text}` });
      changes.push(`Create ${dir}/export_presets.cfg with ${what}.`);
    }
    preset = parseGodotPresets(text)[0]!;
  }
  const path = preset.exportPath;
  const name = path.split("/").pop() ?? "";
  if (!path || path.startsWith("/") || path.includes("\\") || !name || name === "." || name === ".." || !name.endsWith(t.required) || name.length <= t.required.length) {
    return none(`The ${t.label} preset must export to ${t.required ? `a ${t.required} file` : "a file"} inside the project folder (it says "${path}").`);
  }
  const buildPath = normalize([...dir.split("/"), ...path.split("/")]);
  if (!buildPath) return none(`The ${t.label} preset's export path leaves the project folder.`);
  const ignore = input.gitignore ?? "";
  if (!ignore.split(/\r?\n/).some((l) => l.trim() === `${EXPORTS_DIR}/` || l.trim() === `/${EXPORTS_DIR}/`)) {
    writes.push({ path: ".gitignore", content: `${ignore.replace(/\n*$/, ignore ? "\n" : "")}${EXPORTS_DIR}/\n` });
    changes.push(`Add ${EXPORTS_DIR}/ to .gitignore so builds stay out of snapshots.`);
  }
  return { writes, changes, buildPath, problem: null };
}
