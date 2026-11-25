import { emptyAssetIndex, MANIFEST_FILE, PROJECT_SCHEMA_VERSION, STUDIO_VERSION, type ProjectManifest } from "../manifest";
import { assertSafeRelativePath, slugify } from "../paths";

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GenerateOptions {
  title: string;
  description?: string;
  /** Fixed id for tests; otherwise slug plus a random suffix. */
  projectId?: string;
  /** Installed engine release to target, when the template pins one (Unity writes it into ProjectVersion.txt). */
  engineVersion?: string;
  /** Epic's Game Animation Sample on this computer (the realistic Unreal template builds on it). */
  unrealSample?: UnrealSampleFiles;
  now?: Date;
}

/**
 * The text parts of Epic's free Game Animation Sample as the Epic Games Launcher created it (Documents/
 * Unreal Projects/GameAnimationSample). Its content (7 GB of animations, characters and a MetaHuman) is
 * copied into a new project by the app's backend; it never goes into Game Studio's own files.
 */
export interface UnrealSampleFiles {
  /** Config/*.ini by file name, for example "DefaultEngine.ini". */
  config: Record<string, string>;
  /** GameAnimationSample.uproject. */
  uproject: string;
}

export interface GeneratedProject {
  manifest: ProjectManifest;
  files: GeneratedFile[];
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export function projectIdFor(title: string): string {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${slugify(title)}-${suffix}`;
}

export function baseManifest(o: GenerateOptions, fields: Pick<ProjectManifest, "template" | "genre" | "engine" | "modules" | "rules" | "data" | "portableFeatures"> & Partial<ProjectManifest>): ProjectManifest {
  const now = (o.now ?? new Date()).toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    kind: "gamestudio-project",
    projectId: o.projectId ?? projectIdFor(o.title),
    title: o.title.trim(),
    description: (o.description ?? "").trim(),
    createdAt: now,
    updatedAt: now,
    studioVersion: STUDIO_VERSION,
    assetsIndex: "assets/index.json",
    ...fields,
  };
}

export function commonFiles(manifest: ProjectManifest, readme: string, extraIgnores: string[] = []): GeneratedFile[] {
  return [
    { path: MANIFEST_FILE, content: json(manifest) },
    { path: manifest.assetsIndex, content: json(emptyAssetIndex()) },
    { path: "README.md", content: readme },
    {
      path: ".gitignore",
      content: ["# Game Studio local caches", ".gamestudio/cache/", ".DS_Store", ...extraIgnores, ""].join("\n"),
    },
  ];
}

export function finalize(manifest: ProjectManifest, files: GeneratedFile[]): GeneratedProject {
  const seen = new Set<string>();
  for (const f of files) {
    assertSafeRelativePath(f.path);
    if (seen.has(f.path)) throw new Error(`Template produced ${f.path} twice`);
    seen.add(f.path);
  }
  return { manifest, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
