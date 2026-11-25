import { z } from "zod";
import { isSafeRelativePath } from "./paths";

export const PROJECT_SCHEMA_VERSION = "1.0.0";
export const MANIFEST_FILE = "gamestudio.json";
export const STUDIO_VERSION = "0.1.0";

const relPath = z.string().refine(isSafeRelativePath, "Must be a safe project-relative path");
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const manifestSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    kind: z.literal("gamestudio-project"),
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    template: z.object({ id, version: z.string().max(20) }).strict(),
    genre: z.array(z.string().max(40)).max(10),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    studioVersion: z.string().max(20),
    engine: z.discriminatedUnion("id", [
      z.object({ id: z.literal("godot"), version: z.string().max(20), projectDir: relPath, mainScene: z.string().max(200) }).strict(),
      z.object({ id: z.literal("studio-board"), version: z.string().max(20) }).strict(),
      z.object({ id: z.literal("cpp-sfml"), version: z.string().max(20), projectDir: relPath, target: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/) }).strict(),
      z.object({ id: z.literal("unity"), version: z.string().regex(/^\d{4}\.\d+\.\d+[abfpc]\d+$/), projectDir: relPath }).strict(),
      z.object({ id: z.literal("unreal"), version: z.string().regex(/^5\.\d{1,2}$/), projectDir: relPath }).strict(),
    ]),
    modules: z.array(z.string().max(80)).max(50),
    rules: z.array(z.object({ id, path: relPath, domain: z.string().max(32) }).strict()).max(100),
    data: z.array(z.object({ id, path: relPath, kind: z.string().max(40) }).strict()).max(100),
    assetsIndex: relPath,
    portableFeatures: z.array(z.string().max(40)).max(20),
    xr: z
      .object({
        enabled: z.boolean(),
        runtime: z.literal("openxr"),
        targets: z.array(z.string().max(60)).max(10),
        comfort: z.object({ snapTurn: z.boolean(), vignette: z.boolean() }).strict(),
        verifiedOnHeadset: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ProjectManifest = z.infer<typeof manifestSchema>;

export type ManifestResult = { ok: true; manifest: ProjectManifest } | { ok: false; errors: string[] };

export function parseManifest(input: unknown): ManifestResult {
  if (input && typeof input === "object" && "schemaVersion" in input) {
    const version = String((input as { schemaVersion: unknown }).schemaVersion);
    if (version !== PROJECT_SCHEMA_VERSION) {
      const newer = version.localeCompare(PROJECT_SCHEMA_VERSION, undefined, { numeric: true }) > 0;
      return {
        ok: false,
        errors: [newer ? `This project was saved by a newer Game Studio (format ${version}). Update the studio to open it.` : `Unsupported project format ${version}.`],
      };
    }
  }
  const r = manifestSchema.safeParse(input);
  if (r.success) return { ok: true, manifest: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 20).map((i) => `${i.path.map(String).join(".") || "manifest"}: ${i.message}`) };
}

export function touch(manifest: ProjectManifest, now: Date = new Date()): ProjectManifest {
  return { ...manifest, updatedAt: now.toISOString() };
}

export const ASSET_INDEX_VERSION = "1.0.0";

export const assetEntrySchema = z
  .object({
    path: relPath,
    kind: z.enum(["image", "model", "audio", "font", "data", "other"]),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    importedAt: z.iso.datetime(),
    source: z.string().max(500),
    license: z.string().max(200),
    author: z.string().max(200),
    notes: z.string().max(2000),
    tags: z.array(z.string().max(40)).max(20),
  })
  .strict();

export const assetIndexSchema = z
  .object({
    schemaVersion: z.literal(ASSET_INDEX_VERSION),
    kind: z.literal("asset-index"),
    assets: z.array(assetEntrySchema).max(5000),
  })
  .strict();

export type AssetEntry = z.infer<typeof assetEntrySchema>;
export type AssetIndex = z.infer<typeof assetIndexSchema>;

export function emptyAssetIndex(): AssetIndex {
  return { schemaVersion: ASSET_INDEX_VERSION, kind: "asset-index", assets: [] };
}
