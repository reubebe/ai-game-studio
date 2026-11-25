/**
 * Project-relative paths. Every path stored in a manifest or sent to the backend must pass
 * isSafeRelativePath; the Rust backend repeats the check and also refuses symbolic links.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}$/;
/** The only dotfiles a project may contain; .git, .env and every other hidden name stay off limits. */
export const ALLOWED_DOTFILES = new Set([".gitignore", ".gitattributes"]);

export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return segments.every((segment, i) => {
    if (segment === "." || segment === "..") return false;
    if (i === segments.length - 1 && ALLOWED_DOTFILES.has(segment)) return true;
    return SEGMENT.test(segment);
  });
}

export function assertSafeRelativePath(path: string): string {
  if (!isSafeRelativePath(path)) throw new Error(`Unsafe project path: ${JSON.stringify(path)}`);
  return path;
}

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length >= 3 ? slug : `game-${slug || "project"}`.slice(0, 40);
}

/** Folder name for a new project: readable, no characters that trouble shells or Git. */
export function folderNameFor(title: string): string {
  const cleaned = title.replace(/[^A-Za-z0-9 ._()-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return cleaned.length > 0 && /^[A-Za-z0-9]/.test(cleaned) ? cleaned : slugify(title);
}
