//! Saves for games playing in Play here. The game's frame is sandboxed with an opaque origin, so it
//! has no storage of its own. Its page (assets/play-shell.html with assets/play-saves.js) stands in
//! for the browser database Godot keeps user:// in and hands the files to the Play view, which keeps
//! them here: one JSON file per project in the studio's data folder. A game can only write its own
//! file, within the limits below.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const DIR: &str = "play-saves";
/// Upper bound on one project's saves file (its files are stored as base64 text).
pub const MAX_BYTES: usize = 48 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 4096;
/// Godot's web build keeps user:// at /userfs.
const ROOT: &str = "/userfs/";
const S_IFMT: u64 = 0o170000;
const S_IFDIR: u64 = 0o040000;
const S_IFREG: u64 = 0o100000;

/// Where a project's Play here saves live: `<data>/play-saves/<project id>-<hash of its folder>.json`.
/// The folder hash keeps two copies of a project (same id) from sharing saves.
pub fn file_for(data_dir: &Path, project_id: &str, root: &Path) -> PathBuf {
    let id: String = project_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect::<String>().to_ascii_lowercase();
    let hash: String = Sha256::digest(root.to_string_lossy().as_bytes()).iter().take(5).map(|b| format!("{b:02x}")).collect();
    data_dir.join(DIR).join(format!("{}-{hash}.json", if id.is_empty() { "game" } else { id.as_str() }))
}

/// A file or folder inside the game's user:// folder, named the way Godot's web build names it.
pub fn is_safe_save_path(path: &str) -> bool {
    path.len() <= 512
        && path.starts_with(ROOT)
        && path[ROOT.len()..].split('/').all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.chars().any(|c| c.is_control() || c == '\\'))
}

fn is_base64(s: &str) -> bool {
    s.len() % 4 == 0 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

/// Checks a saves file and returns how many files it holds. The format:
/// `{"version": 1, "entries": {"/userfs/<path>": {"timestamp": <ms>, "mode": <st_mode>, "data": <base64, files only>}}}`.
pub fn validate(text: &str) -> Result<usize, String> {
    if text.len() > MAX_BYTES {
        return Err(format!("they are larger than {} MB", MAX_BYTES / 1024 / 1024));
    }
    let v: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    if v.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("unknown format version".into());
    }
    let entries = v.get("entries").and_then(Value::as_object).ok_or("no entries")?;
    if entries.len() > MAX_ENTRIES {
        return Err(format!("more than {MAX_ENTRIES} files and folders"));
    }
    let mut files = 0;
    for (path, entry) in entries {
        if !is_safe_save_path(path) {
            return Err(format!("{path:?} is not inside the game's user:// folder"));
        }
        let fields = entry.as_object().ok_or_else(|| format!("{path}: not an object"))?;
        if fields.keys().any(|k| !matches!(k.as_str(), "timestamp" | "mode" | "data")) {
            return Err(format!("{path}: unexpected field"));
        }
        if !fields.get("timestamp").and_then(Value::as_f64).is_some_and(|t| t.is_finite() && t >= 0.0) {
            return Err(format!("{path}: bad timestamp"));
        }
        let mode = fields.get("mode").and_then(Value::as_u64).ok_or_else(|| format!("{path}: bad mode"))?;
        match mode & S_IFMT {
            S_IFDIR if !fields.contains_key("data") => {}
            S_IFREG if fields.get("data").and_then(Value::as_str).is_some_and(is_base64) => files += 1,
            _ => return Err(format!("{path}: not a plain file or folder")),
        }
    }
    Ok(files)
}

/// The saves file's text, or None when the game has no saves yet.
pub fn read(file: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(file) {
        Ok(text) => validate(&text).map(|_| Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Replaces the saves file (written next to it first, then renamed, so a crash cannot leave half a file).
pub fn write(file: &Path, text: &str) -> Result<usize, String> {
    let files = validate(text)?;
    let dir = file.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())?;
    Ok(files)
}

pub fn clear(file: &Path) -> Result<(), String> {
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saves(entries: &str) -> String {
        format!(r#"{{"version":1,"entries":{{{entries}}}}}"#)
    }

    #[test]
    fn save_paths_stay_inside_user_folder() {
        for ok in ["/userfs/progress.json", "/userfs/saves/slot 1.dat", "/userfs/a.b"] {
            assert!(is_safe_save_path(ok), "{ok}");
        }
        for bad in ["/userfs/", "/userfs", "/userfs/../x", "/userfs/./x", "/userfs//x", "/tmp/x", "userfs/x", "/userfs/a\\b", "/userfs/a\u{0}b", "/userfs/x/.."] {
            assert!(!is_safe_save_path(bad), "{bad}");
        }
        assert!(!is_safe_save_path(&format!("/userfs/{}", "a".repeat(600))));
    }

    #[test]
    fn validates_the_saves_format() {
        let good = saves(r#""/userfs/saves":{"timestamp":1,"mode":16877},"/userfs/saves/p.json":{"timestamp":1700000000000,"mode":33206,"data":"eyJhIjoxfQ=="}"#);
        assert_eq!(validate(&good), Ok(1));
        assert_eq!(validate(&saves("")), Ok(0));
        for bad in [
            r#"{"version":2,"entries":{}}"#.to_string(),
            r#"{"version":1}"#.to_string(),
            saves(r#""/etc/passwd":{"timestamp":1,"mode":33206,"data":""}"#),
            saves(r#""/userfs/a":{"timestamp":1,"mode":16877,"data":""}"#),
            saves(r#""/userfs/a":{"timestamp":1,"mode":33206}"#),
            saves(r#""/userfs/a":{"timestamp":1,"mode":33206,"data":"not base64!"}"#),
            saves(r#""/userfs/a":{"timestamp":1,"mode":41471,"data":""}"#),
            saves(r#""/userfs/a":{"timestamp":-1,"mode":33206,"data":""}"#),
            saves(r#""/userfs/a":{"timestamp":1,"mode":33206,"data":"","extra":1}"#),
            "not json".to_string(),
        ] {
            assert!(validate(&bad).is_err(), "{bad}");
        }
        let many: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!(r#""/userfs/f{i}":{{"timestamp":1,"mode":33206,"data":""}}"#)).collect();
        assert!(validate(&saves(&many.join(","))).is_err());
    }

    #[test]
    fn one_file_per_project_folder() {
        let data = Path::new("/data");
        let a = file_for(data, "Smoke-Valley_01", Path::new("/projects/a"));
        let b = file_for(data, "Smoke-Valley_01", Path::new("/projects/b"));
        assert_ne!(a, b);
        assert!(a.starts_with("/data/play-saves"));
        let name = a.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("smoke-valley01-") && name.ends_with(".json"), "{name}");
        assert!(file_for(data, "../../x", Path::new("/p")).starts_with("/data/play-saves"));
    }

    #[test]
    fn writes_reads_and_clears() {
        let dir = std::env::temp_dir().join(format!("gs-saves-{}", uuid::Uuid::new_v4().simple()));
        let file = file_for(&dir, "game", Path::new("/p"));
        assert_eq!(read(&file), Ok(None));
        let text = saves(r#""/userfs/p.json":{"timestamp":5,"mode":33206,"data":"e30="}"#);
        assert_eq!(write(&file, &text), Ok(1));
        assert_eq!(read(&file), Ok(Some(text)));
        assert!(write(&file, "{}").is_err());
        std::fs::write(&file, "garbage").unwrap();
        assert!(read(&file).is_err());
        assert_eq!(clear(&file), Ok(()));
        assert_eq!(clear(&file), Ok(()));
        assert_eq!(read(&file), Ok(None));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
