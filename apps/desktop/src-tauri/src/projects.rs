use crate::error::{AppError, AppResult};
use crate::paths::{is_safe_folder_name, resolve_in_root};
use crate::timeutil::{iso_from_unix, now_iso};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MANIFEST: &str = "gamestudio.json";
const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_WRITE_TOTAL: usize = 50 * 1024 * 1024;
const MAX_IMPORT_BYTES: u64 = 200 * 1024 * 1024;
const MAX_LISTED: usize = 20_000;
/// Folders hidden from the project explorer: version control, engine caches and studio internals.
const SKIP_DIRS: [&str; 4] = [".git", ".godot", ".gamestudio", "node_modules"];
/// Folders Unity regenerates; skipped only next to a Unity project's ProjectSettings/ProjectVersion.txt.
const UNITY_GENERATED: [&str; 5] = ["Library", "Temp", "Logs", "obj", "UserSettings"];
/// Folders Unreal regenerates; skipped only next to a .uproject file.
const UNREAL_GENERATED: [&str; 4] = ["Binaries", "Intermediate", "Saved", "DerivedDataCache"];

fn has_uproject(dir: &Path) -> bool {
    fs::read_dir(dir).map(|entries| entries.filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().ends_with(".uproject"))).unwrap_or(false)
}

fn skipped_dir(e: &walkdir::DirEntry) -> bool {
    let name = e.file_name().to_string_lossy();
    if SKIP_DIRS.contains(&name.as_ref()) {
        return true;
    }
    let Some(parent) = e.path().parent() else { return false };
    (UNITY_GENERATED.contains(&name.as_ref()) && parent.join("ProjectSettings/ProjectVersion.txt").is_file()) || (UNREAL_GENERATED.contains(&name.as_ref()) && has_uproject(parent))
}

#[derive(Debug, Deserialize)]
pub struct NewFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    pub path: String,
    pub source_name: String,
    pub bytes: u64,
    pub sha256: String,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Write a file by writing a temporary sibling and renaming it, so readers never see half a file.
pub fn atomic_write(path: &Path, content: &[u8]) -> AppResult<()> {
    let dir = path.parent().ok_or_else(|| AppError::Invalid("File has no parent folder".into()))?;
    fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::Io(e)
    })
}

/// Read and lightly check the manifest. Full schema validation happens in the TypeScript project package.
pub fn read_manifest(root: &Path) -> AppResult<(String, serde_json::Value)> {
    let path = root.join(MANIFEST);
    let meta = fs::symlink_metadata(&path).map_err(|_| AppError::NotFound("This folder is not a Game Studio project (no gamestudio.json)".into()))?;
    if !meta.is_file() {
        return Err(AppError::Invalid("gamestudio.json is not a regular file".into()));
    }
    if meta.len() > 1024 * 1024 {
        return Err(AppError::Invalid("gamestudio.json is too large".into()));
    }
    let text = fs::read_to_string(&path)?;
    let value: serde_json::Value = serde_json::from_str(&text)?;
    if value.get("kind").and_then(|k| k.as_str()) != Some("gamestudio-project") {
        return Err(AppError::Invalid("gamestudio.json is not a Game Studio project manifest".into()));
    }
    Ok((text, value))
}

fn validate_files(files: &[NewFile]) -> AppResult<()> {
    let total: usize = files.iter().map(|f| f.content.len()).sum();
    if total > MAX_WRITE_TOTAL {
        return Err(AppError::Invalid("Too much data in one save".into()));
    }
    for f in files {
        if !crate::paths::is_safe_relative(&f.path) {
            return Err(AppError::Denied(format!("'{}' is not an allowed project path", f.path)));
        }
        if f.content.len() as u64 > MAX_TEXT_BYTES {
            return Err(AppError::Invalid(format!("{} is larger than 5 MB", f.path)));
        }
    }
    Ok(())
}

/// Create a project folder from generated files. Files are written to a staging folder first and
/// renamed into place, so a failure never leaves a half-created project behind.
pub fn create_project(parent: &Path, folder: &str, files: &[NewFile]) -> AppResult<PathBuf> {
    if !is_safe_folder_name(folder) {
        return Err(AppError::Invalid(format!("'{folder}' cannot be used as a folder name")));
    }
    if !files.iter().any(|f| f.path == MANIFEST) {
        return Err(AppError::Invalid("A project needs a gamestudio.json manifest".into()));
    }
    validate_files(files)?;
    let target = parent.join(folder);
    if target.exists() {
        return Err(AppError::Conflict(format!("A folder named '{folder}' already exists there")));
    }
    let staging = parent.join(format!(".gamestudio-staging-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging)?;
    let result = (|| -> AppResult<()> {
        for f in files {
            let path = resolve_in_root(&staging, &f.path)?;
            atomic_write(&path, f.content.as_bytes())?;
        }
        fs::rename(&staging, &target)?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(target.canonicalize()?)
}

pub fn list_files(root: &Path) -> AppResult<Vec<FileEntry>> {
    let mut out = Vec::new();
    let mut walker = walkdir::WalkDir::new(root).follow_links(false).max_depth(16).sort_by_file_name().into_iter().filter_entry(|e| e.depth() == 0 || !(e.file_type().is_dir() && skipped_dir(e)));
    while let Some(entry) = walker.next() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        // App bundles (exported games) are listed as one item, as Finder shows them.
        if entry.depth() > 0 && entry.file_type().is_dir() && entry.file_name().to_string_lossy().ends_with(".app") {
            walker.skip_current_dir();
        }
        if entry.depth() == 0 {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name.starts_with('.') && !crate::paths::ALLOWED_DOTFILES.contains(&name.as_ref()) {
            continue;
        }
        let rel = entry.path().strip_prefix(root).map_err(|_| AppError::Internal("walk escaped root".into()))?;
        let rel = rel.to_string_lossy().replace('\\', "/");
        let meta = entry.path().symlink_metadata()?;
        let kind = if meta.file_type().is_symlink() { "symlink" } else if meta.is_dir() { "dir" } else { "file" };
        let modified = meta.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map(|d| iso_from_unix(d.as_secs()));
        out.push(FileEntry { path: rel, kind, size: if meta.is_file() { meta.len() } else { 0 }, modified });
        if out.len() >= MAX_LISTED {
            break;
        }
    }
    Ok(out)
}

pub fn read_text(root: &Path, rel: &str) -> AppResult<String> {
    let path = resolve_in_root(root, rel)?;
    let meta = fs::metadata(&path).map_err(|_| AppError::NotFound(format!("{rel} does not exist")))?;
    if !meta.is_file() {
        return Err(AppError::Invalid(format!("{rel} is not a file")));
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(AppError::Invalid(format!("{rel} is larger than 5 MB; open it in a dedicated tool")));
    }
    let bytes = fs::read(&path)?;
    String::from_utf8(bytes).map_err(|_| AppError::Invalid(format!("{rel} is not a text file")))
}

pub fn write_texts(root: &Path, files: &[NewFile]) -> AppResult<()> {
    validate_files(files)?;
    for f in files {
        let path = resolve_in_root(root, &f.path)?;
        atomic_write(&path, f.content.as_bytes())?;
    }
    Ok(())
}

/// Move a file or folder into the project's own trash instead of deleting it.
pub fn trash(root: &Path, rel: &str) -> AppResult<String> {
    if rel == MANIFEST {
        return Err(AppError::Denied("The project manifest cannot be removed".into()));
    }
    let source = resolve_in_root(root, rel)?;
    if !source.exists() {
        return Err(AppError::NotFound(format!("{rel} does not exist")));
    }
    let stamp = now_iso().replace(':', "-");
    let dest_rel = format!(".gamestudio/trash/{stamp}/{rel}");
    let dest = root.join(&dest_rel);
    fs::create_dir_all(dest.parent().unwrap())?;
    fs::rename(&source, &dest)?;
    Ok(dest_rel)
}

fn unique_destination(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for i in 2..10_000 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    dir.join(format!("{stem}-{}{ext}", uuid::Uuid::new_v4()))
}

fn clean_file_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '(' | ')' | '-') { c } else { '_' }).collect();
    let trimmed = cleaned.trim_start_matches(|c: char| !c.is_ascii_alphanumeric()).trim().to_string();
    if trimmed.is_empty() { "asset".to_string() } else { trimmed.chars().take(100).collect() }
}

/// Copy user-chosen files into the project. Callers must pass only paths the user picked or dropped.
pub fn import_files(root: &Path, sources: &[PathBuf], dest_dir: &str) -> AppResult<Vec<ImportedFile>> {
    let dir = resolve_in_root(root, dest_dir)?;
    fs::create_dir_all(&dir)?;
    let mut out = Vec::new();
    for source in sources {
        let meta = fs::symlink_metadata(source).map_err(|_| AppError::NotFound(format!("{} no longer exists", source.display())))?;
        if !meta.is_file() {
            return Err(AppError::Invalid(format!("{} is not a regular file", source.display())));
        }
        if meta.len() > MAX_IMPORT_BYTES {
            return Err(AppError::Invalid(format!("{} is larger than 200 MB", source.display())));
        }
        let original = source.file_name().and_then(|n| n.to_str()).unwrap_or("asset");
        let dest = unique_destination(&dir, &clean_file_name(original));
        let bytes = fs::read(source)?;
        let digest = Sha256::digest(&bytes);
        atomic_write(&dest, &bytes)?;
        let rel = dest.strip_prefix(root).map_err(|_| AppError::Internal("import escaped root".into()))?.to_string_lossy().replace('\\', "/");
        out.push(ImportedFile { path: rel, source_name: original.to_string(), bytes: meta.len(), sha256: hex(&digest) });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> Vec<NewFile> {
        vec![
            NewFile { path: MANIFEST.into(), content: r#"{"kind":"gamestudio-project","schemaVersion":"1.0.0","title":"T"}"#.into() },
            NewFile { path: "rules/a.rules.json".into(), content: "{}".into() },
            NewFile { path: ".gitignore".into(), content: ".gamestudio/cache/\n".into() },
        ]
    }

    #[test]
    fn creates_and_lists_a_project() {
        let parent = tempfile::tempdir().unwrap();
        let root = create_project(parent.path(), "My Game", &files()).unwrap();
        assert!(root.join("rules/a.rules.json").is_file());
        let listed: Vec<String> = list_files(&root).unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(listed, vec![".gitignore", "gamestudio.json", "rules", "rules/a.rules.json"]);
        assert!(read_manifest(&root).is_ok());
        // No staging folders are left behind.
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
    }

    #[test]
    fn refuses_existing_folders_and_bad_paths_without_leftovers() {
        let parent = tempfile::tempdir().unwrap();
        create_project(parent.path(), "Game", &files()).unwrap();
        assert!(matches!(create_project(parent.path(), "Game", &files()), Err(AppError::Conflict(_))));
        let mut bad = files();
        bad.push(NewFile { path: "../escape.txt".into(), content: "x".into() });
        assert!(matches!(create_project(parent.path(), "Other", &bad), Err(AppError::Denied(_))));
        assert!(!parent.path().join("Other").exists());
        assert!(!parent.path().join("escape.txt").exists());
        assert!(matches!(create_project(parent.path(), "a/b", &files()), Err(AppError::Invalid(_))));
    }

    #[test]
    fn reads_writes_and_trashes_inside_the_root_only() {
        let parent = tempfile::tempdir().unwrap();
        let root = create_project(parent.path(), "Game", &files()).unwrap();
        write_texts(&root, &[NewFile { path: "data/world.json".into(), content: "{\"a\":1}".into() }]).unwrap();
        assert_eq!(read_text(&root, "data/world.json").unwrap(), "{\"a\":1}");
        assert!(matches!(read_text(&root, "../../etc/hosts"), Err(AppError::Denied(_))));
        assert!(matches!(write_texts(&root, &[NewFile { path: ".git/config".into(), content: "x".into() }]), Err(AppError::Denied(_))));
        assert!(matches!(trash(&root, MANIFEST), Err(AppError::Denied(_))));
        let moved = trash(&root, "data/world.json").unwrap();
        assert!(!root.join("data/world.json").exists());
        assert!(root.join(&moved).is_file());
        assert!(!list_files(&root).unwrap().iter().any(|e| e.path.starts_with(".gamestudio")));
    }

    #[test]
    fn lists_app_bundles_as_one_item_and_skips_unity_caches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for f in ["exports/macos/Game.app/Contents/MacOS/Game", "unity/Assets/A.cs", "unity/ProjectSettings/ProjectVersion.txt", "unity/Library/big.bin", "unity/Temp/x", "notes/Library/keep.txt", "unreal/StudioValley.uproject", "unreal/Source/A.cpp", "unreal/Intermediate/x.o", "unreal/Saved/Logs/l.log", "docs/Saved/keep.md"] {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        let listed: Vec<String> = list_files(root).unwrap().into_iter().map(|e| e.path).collect();
        assert!(listed.contains(&"exports/macos/Game.app".to_string()));
        assert!(!listed.iter().any(|p| p.contains("Game.app/")), "{listed:?}");
        assert!(listed.contains(&"unity/Assets/A.cs".to_string()));
        assert!(!listed.iter().any(|p| p.starts_with("unity/Library") || p.starts_with("unity/Temp")), "{listed:?}");
        assert!(listed.contains(&"notes/Library/keep.txt".to_string()), "Library is skipped only inside Unity projects");
        assert!(listed.contains(&"unreal/Source/A.cpp".to_string()));
        assert!(!listed.iter().any(|p| p.starts_with("unreal/Intermediate") || p.starts_with("unreal/Saved")), "{listed:?}");
        assert!(listed.contains(&"docs/Saved/keep.md".to_string()), "Saved is skipped only next to a .uproject");
    }

    #[test]
    fn rejects_non_projects() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(read_manifest(dir.path()), Err(AppError::NotFound(_))));
        fs::write(dir.path().join(MANIFEST), r#"{"kind":"something-else"}"#).unwrap();
        assert!(matches!(read_manifest(dir.path()), Err(AppError::Invalid(_))));
    }

    #[test]
    fn imports_files_with_safe_unique_names_and_checksums() {
        let parent = tempfile::tempdir().unwrap();
        let root = create_project(parent.path(), "Game", &files()).unwrap();
        let src = tempfile::tempdir().unwrap();
        let a = src.path().join("weird name!.png");
        fs::write(&a, b"PNGDATA").unwrap();
        let first = import_files(&root, &[a.clone()], "assets/images").unwrap();
        let second = import_files(&root, &[a.clone()], "assets/images").unwrap();
        assert_eq!(first[0].path, "assets/images/weird name_.png");
        assert_eq!(second[0].path, "assets/images/weird name_ (2).png");
        assert_eq!(first[0].sha256, "2d4566582844690f8634a8b2534ea5221560038c6c0650c99140759bad603ae2");
        let link = src.path().join("link.png");
        std::os::unix::fs::symlink(&a, &link).unwrap();
        assert!(import_files(&root, &[link], "assets").is_err());
    }
}
