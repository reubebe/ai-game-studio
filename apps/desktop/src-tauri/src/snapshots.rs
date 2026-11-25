use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// Project snapshots are ordinary Git commits made with the system `git`.
/// Hooks and commit signing are disabled so a project folder can never run code through them.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub short_id: String,
    pub message: String,
    pub at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStatus {
    pub git_available: bool,
    pub initialized: bool,
    pub dirty: bool,
    pub head: Option<Snapshot>,
}

fn git(root: &Path, args: &[&str]) -> AppResult<String> {
    let output = Command::new("git")
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
        .args(args)
        .output()
        .map_err(|e| AppError::Unavailable(format!("Git is not available: {e}")))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Internal(format!("git {} failed: {}", args.first().unwrap_or(&""), err.trim())));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn git_available() -> bool {
    Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

fn initialized(root: &Path) -> bool {
    root.join(".git").is_dir()
}

pub fn init(root: &Path) -> AppResult<()> {
    if !initialized(root) {
        git(root, &["init", "-q", "-b", "main"])?;
    }
    Ok(())
}

fn parse_log(text: &str) -> Vec<Snapshot> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            let id = parts.next()?.to_string();
            let at = parts.next()?.to_string();
            let message = parts.next().unwrap_or("").to_string();
            Some(Snapshot { short_id: id.chars().take(8).collect(), id, message, at })
        })
        .collect()
}

pub fn list(root: &Path, limit: u32) -> AppResult<Vec<Snapshot>> {
    if !initialized(root) {
        return Ok(vec![]);
    }
    // An empty repository has no HEAD yet.
    if git(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Ok(vec![]);
    }
    let limit = format!("-n{}", limit.min(500));
    Ok(parse_log(&git(root, &["log", &limit, "--format=%H%x1f%aI%x1f%s"])?))
}

pub fn status(root: &Path) -> AppResult<SnapshotStatus> {
    let available = git_available();
    if !available || !initialized(root) {
        return Ok(SnapshotStatus { git_available: available, initialized: initialized(root), dirty: false, head: None });
    }
    let dirty = !git(root, &["status", "--porcelain"])?.trim().is_empty();
    let head = list(root, 1)?.into_iter().next();
    Ok(SnapshotStatus { git_available: true, initialized: true, dirty, head })
}

/// Commit all current changes. Returns None when there is nothing to save.
pub fn create(root: &Path, message: &str) -> AppResult<Option<Snapshot>> {
    let message = message.trim();
    if message.is_empty() || message.len() > 300 || message.contains('\0') {
        return Err(AppError::Invalid("Give the snapshot a short description".into()));
    }
    init(root)?;
    git(root, &["add", "-A"])?;
    if git(root, &["status", "--porcelain"])?.trim().is_empty() {
        return Ok(None);
    }
    git(root, &["-c", "user.name=Game Studio", "-c", "user.email=studio@localhost", "commit", "-q", "-m", message])?;
    Ok(list(root, 1)?.into_iter().next())
}

fn valid_id(id: &str) -> bool {
    (7..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// Make the project match a snapshot. Unsaved changes are snapshotted first, so nothing is lost.
pub fn restore(root: &Path, id: &str) -> AppResult<Snapshot> {
    if !valid_id(id) {
        return Err(AppError::Invalid("Unknown snapshot".into()));
    }
    let target = format!("{id}^{{commit}}");
    git(root, &["cat-file", "-e", &target]).map_err(|_| AppError::NotFound("That snapshot does not exist in this project".into()))?;
    let short: String = id.chars().take(8).collect();
    create(root, &format!("Before restoring snapshot {short}"))?;
    git(root, &["restore", &format!("--source={id}"), "--staged", "--worktree", "--", "."])?;
    let subject = git(root, &["log", "-n1", "--format=%s", id])?.trim().to_string();
    match create(root, &format!("Restored snapshot {short}: {subject}"))? {
        Some(s) => Ok(s),
        None => list(root, 1)?.into_iter().next().ok_or_else(|| AppError::Internal("No snapshot after restore".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn snapshots_and_restores_exactly() {
        if !git_available() {
            eprintln!("git not available; skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("gamestudio.json"), "{\"v\":1}").unwrap();
        let first = create(root, "Created project").unwrap().unwrap();
        assert!(create(root, "Nothing changed").unwrap().is_none());

        fs::write(root.join("gamestudio.json"), "{\"v\":2}").unwrap();
        fs::write(root.join("added.txt"), "new").unwrap();
        assert!(status(root).unwrap().dirty);
        create(root, "Second").unwrap().unwrap();
        fs::write(root.join("gamestudio.json"), "{\"v\":3, \"unsaved\": true}").unwrap();

        let restored = restore(root, &first.id).unwrap();
        assert!(restored.message.starts_with("Restored snapshot"));
        assert_eq!(fs::read_to_string(root.join("gamestudio.json")).unwrap(), "{\"v\":1}");
        assert!(!root.join("added.txt").exists(), "files added after the snapshot are removed");

        let messages: Vec<String> = list(root, 10).unwrap().into_iter().map(|s| s.message).collect();
        assert_eq!(messages[1], format!("Before restoring snapshot {}", &first.id[..8]), "unsaved work was kept");
        assert!(!status(root).unwrap().dirty);
    }

    #[test]
    fn rejects_bad_ids_and_empty_messages() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(restore(dir.path(), "HEAD; rm -rf /"), Err(AppError::Invalid(_))));
        assert!(matches!(create(dir.path(), "   "), Err(AppError::Invalid(_))));
    }

    #[test]
    fn hooks_never_run() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init(root).unwrap();
        let marker = root.join("hook-ran");
        let hook = root.join(".git/hooks/pre-commit");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("a.txt"), "x").unwrap();
        create(root, "With a hostile hook present").unwrap();
        assert!(!marker.exists());
    }
}
