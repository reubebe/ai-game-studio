import { assetIndexSchema, emptyAssetIndex, type AssetEntry, type AssetIndex } from "@gamestudio/project";
import { backend, type ImportedFile, type LibraryCharacter } from "../../lib/backend";

const MODEL = /\.(glb|gltf|vrm)$/i;

/** How the asset library records a free character's files: the model, its textures and its licence notice. */
export function characterEntries(files: ImportedFile[], c: LibraryCharacter, now = new Date().toISOString()): AssetEntry[] {
  return files.map((f) => ({
    path: f.path,
    kind: MODEL.test(f.path) ? ("model" as const) : /\.txt$/i.test(f.path) ? ("data" as const) : ("image" as const),
    bytes: f.bytes,
    sha256: f.sha256,
    importedAt: now,
    source: f.sourceName,
    license: c.license,
    author: c.author,
    notes: MODEL.test(f.path) ? `${c.name}. Animations: ${c.clips.join(", ")}. About ${c.height} m tall.` : /\.txt$/i.test(f.path) ? `Licence notice for ${c.name}; keep it with the model.` : `Texture for ${c.name}.`,
    tags: MODEL.test(f.path) ? ["character", "animated"] : ["character"],
  }));
}

/** Adds entries to the project's asset index (replacing ones for the same files) and writes it. */
export async function recordAssets(root: string, indexPath: string, entries: AssetEntry[]): Promise<AssetIndex> {
  let index = emptyAssetIndex();
  try {
    const parsed = assetIndexSchema.safeParse(JSON.parse(await backend.projectRead(root, indexPath)));
    if (parsed.success) index = parsed.data;
  } catch {
    // No index yet: start one.
  }
  const next = { ...index, assets: [...index.assets.filter((a) => !entries.some((e) => e.path === a.path)), ...entries] };
  await backend.projectWrite(root, [{ path: indexPath, content: JSON.stringify(next, null, 2) + "\n" }]);
  return next;
}

/** The library's characters, listed once while the app runs. */
let catalog: Promise<LibraryCharacter[]> | null = null;
export function libraryCharacters(): Promise<LibraryCharacter[]> {
  if (!catalog) {
    catalog = backend.libraryCharacters();
    catalog.catch(() => (catalog = null));
  }
  return catalog;
}

/** The free character that suits a level's style: a realistic person, the anime Godette, or the robot. */
export function suggestedCharacter(style: string | undefined): string {
  return style === "realistic" ? "rocketbox-woman" : style === "anime" ? "godette" : "robot-expressive";
}

/**
 * Downloads a free character into the Godot project's assets/characters, records it in the asset
 * index and returns the model's path inside the Godot project (assets/characters/...).
 */
export async function addLibraryCharacter(root: string, engineDir: string, indexPath: string, c: LibraryCharacter): Promise<string> {
  const files = await backend.libraryDownload(root, "characters", c.id, "1k", `${engineDir}/assets/characters`);
  await recordAssets(root, indexPath, characterEntries(files, c));
  const model = files.find((f) => MODEL.test(f.path));
  if (!model) throw new Error(`${c.name} came without a model file.`);
  return model.path.startsWith(`${engineDir}/`) ? model.path.slice(engineDir.length + 1) : model.path;
}
