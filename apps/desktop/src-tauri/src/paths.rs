use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

/// The only dotfiles a project may contain. `.git`, `.env` and other hidden names stay off limits.
pub const ALLOWED_DOTFILES: [&str; 2] = [".gitignore", ".gitattributes"];

fn segment_ok(segment: &str, last: bool) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." || segment.len() > 128 {
        return false;
    }
    if last && ALLOWED_DOTFILES.contains(&segment) {
        return true;
    }
    let mut chars = segment.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '(' | ')' | '-'))
}

/// Mirrors `isSafeRelativePath` in packages/project/src/paths.ts.
pub fn is_safe_relative(rel: &str) -> bool {
    if rel.is_empty() || rel.len() > 512 || rel.starts_with('/') || rel.contains('\\') || rel.contains('\0') {
        return false;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let n = parts.len();
    parts.iter().enumerate().all(|(i, s)| segment_ok(s, i == n - 1))
}

/// A single folder name for a new project directory.
pub fn is_safe_folder_name(name: &str) -> bool {
    !name.contains('/') && is_safe_relative(name) && !name.starts_with('.') && name.trim() == name
}

/// Resolve `rel` inside `root`, refusing unsafe names and any symbolic link on the way.
pub fn resolve_in_root(root: &Path, rel: &str) -> AppResult<PathBuf> {
    if !is_safe_relative(rel) {
        return Err(AppError::Denied(format!("'{rel}' is not an allowed project path")));
    }
    let mut current = root.to_path_buf();
    for part in Path::new(rel).components() {
        match part {
            Component::Normal(p) => current.push(p),
            _ => return Err(AppError::Denied(format!("'{rel}' is not an allowed project path"))),
        }
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(AppError::Denied(format!("'{rel}' goes through a symbolic link, which Game Studio does not follow")));
            }
            _ => {}
        }
    }
    Ok(current)
}

/// Canonical directory path, refusing files, missing paths and symbolic links at the top level.
pub fn canonical_dir(path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(AppError::Invalid("Use an absolute folder path".into()));
    }
    let meta = std::fs::symlink_metadata(&p).map_err(|_| AppError::NotFound(format!("Folder not found: {path}")))?;
    if meta.file_type().is_symlink() {
        return Err(AppError::Denied("Project folders cannot be symbolic links".into()));
    }
    if !meta.is_dir() {
        return Err(AppError::Invalid(format!("Not a folder: {path}")));
    }
    Ok(p.canonicalize()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_the_typescript_rules() {
        for ok in ["gamestudio.json", "rules/a.rules.json", "godot/scenes/main.tscn", "assets/My Image (1).png", ".gitignore", "godot/.gitattributes"] {
            assert!(is_safe_relative(ok), "{ok}");
        }
        for bad in ["", "/etc/passwd", "../x", "a/../../b", "a//b", "a\\b", "./a", ".hidden", "a/.git/config", "a\0b", ".env", ".gitignore/x", ".git"] {
            assert!(!is_safe_relative(bad), "{bad:?}");
        }
    }

    #[test]
    fn refuses_symlinks_inside_a_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("rules")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert!(resolve_in_root(dir.path(), "rules/a.json").is_ok());
        assert!(matches!(resolve_in_root(dir.path(), "link/secret.txt"), Err(AppError::Denied(_))));
        assert!(matches!(resolve_in_root(dir.path(), "../escape"), Err(AppError::Denied(_))));
    }

    #[test]
    fn folder_names_are_single_safe_segments() {
        assert!(is_safe_folder_name("Sun Crystal Valley"));
        assert!(!is_safe_folder_name("a/b"));
        assert!(!is_safe_folder_name(".hidden"));
        assert!(!is_safe_folder_name(" padded "));
    }
}
