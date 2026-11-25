//! Epic's free Game Animation Sample, which the realistic Unreal template builds on. The person adds it
//! from Fab and creates it with the Epic Games Launcher (Documents/Unreal Projects/GameAnimationSample).
//! Game Studio reads its settings (text) for the template and copies its content into a new project;
//! nothing of it goes into Game Studio's own files. On APFS `std::fs::copy` makes clones, so the 7 GB
//! of content takes no extra space.

use crate::error::{AppError, AppResult};
use crate::paths::resolve_in_root;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SAMPLE_PROJECT: &str = "GameAnimationSample.uproject";

/// Shown when the sample is missing (the New Project dialog says the same).
pub const HOW_TO: &str = "Add \u{201c}Game Animation Sample\u{201d} (Epic Games, free) to your library on fab.com, then in the Epic Games Launcher choose Unreal Engine \u{203a} Library \u{203a} Fab Library \u{203a} Game Animation Sample \u{203a} Create Project with version 5.8 and the suggested folder (Documents \u{203a} Unreal Projects).";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SampleFiles {
    pub path: String,
    pub engine_version: Option<String>,
    /// Config/*.ini by file name.
    pub config: BTreeMap<String, String>,
    pub uproject: String,
}

#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SampleCopy {
    pub files: u64,
    pub bytes: u64,
}

/// Where the Epic Games Launcher creates projects by default.
pub fn launcher_projects_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Documents/Unreal Projects"))
}

fn is_sample(dir: &Path) -> bool {
    dir.join(SAMPLE_PROJECT).is_file() && dir.join("Content").is_dir() && dir.join("Config").is_dir()
}

/// The sample in `dir`: the launcher's default folder name first, else any folder holding its .uproject.
pub fn find_sample_in(dir: &Path) -> Option<PathBuf> {
    let default = dir.join("GameAnimationSample");
    if is_sample(&default) {
        return Some(default);
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| is_sample(p)).collect();
    found.sort();
    found.into_iter().next()
}

pub fn find_sample() -> Option<PathBuf> {
    launcher_projects_dir().and_then(|d| find_sample_in(&d))
}

/// The sample's settings files and project file.
pub fn read_sample(sample: &Path) -> AppResult<SampleFiles> {
    let uproject = std::fs::read_to_string(sample.join(SAMPLE_PROJECT))?;
    let engine_version = serde_json::from_str::<serde_json::Value>(&uproject).ok().and_then(|v| v.get("EngineAssociation").and_then(|e| e.as_str()).map(String::from));
    let mut config = BTreeMap::new();
    for entry in std::fs::read_dir(sample.join("Config"))? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        let plain = name.ends_with(".ini") && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
        if !plain || !entry.file_type()?.is_file() {
            continue;
        }
        if entry.metadata()?.len() > 2_000_000 {
            return Err(AppError::Invalid(format!("{name} in the Game Animation Sample is unexpectedly large")));
        }
        config.insert(name, std::fs::read_to_string(entry.path())?);
    }
    Ok(SampleFiles { path: sample.to_string_lossy().to_string(), engine_version, config, uproject })
}

/// Copies the sample's content into `<root>/<engine_dir>/Content`: every top-level folder except Game
/// Studio's own GameStudioData, never over a folder that is already there (each folder is copied under a
/// hidden name and renamed when complete, so a copy that stopped halfway is redone). Also copies the
/// sample's prebuilt cache (DerivedDataCache/Compressed.ddp), which saves a long first load. Symbolic
/// links in the sample are skipped.
pub fn copy_sample(sample: &Path, root: &Path, engine_dir: &str) -> AppResult<SampleCopy> {
    let engine = resolve_in_root(root, engine_dir)?;
    if !engine.join("StudioValley.uproject").is_file() {
        return Err(AppError::NotFound(format!("{engine_dir} is not an Unreal project made by Game Studio")));
    }
    let content = resolve_in_root(root, &format!("{engine_dir}/Content"))?;
    std::fs::create_dir_all(&content)?;
    let mut copied = SampleCopy::default();
    let mut entries: Vec<_> = std::fs::read_dir(sample.join("Content"))?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "GameStudioData" || name.starts_with('.') {
            continue;
        }
        let target = content.join(&name);
        if std::fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        let partial = content.join(format!(".gamestudio-copy-{name}"));
        if std::fs::symlink_metadata(&partial).is_ok() {
            std::fs::remove_dir_all(&partial).or_else(|_| std::fs::remove_file(&partial))?;
        }
        copy_tree(&entry.path(), &partial, &mut copied)?;
        std::fs::rename(&partial, &target)?;
    }
    let pak = sample.join("DerivedDataCache/Compressed.ddp");
    if std::fs::symlink_metadata(&pak).map(|m| m.is_file()).unwrap_or(false) {
        let dir = resolve_in_root(root, &format!("{engine_dir}/DerivedDataCache"))?;
        std::fs::create_dir_all(&dir)?;
        let target = dir.join("Compressed.ddp");
        if !target.exists() {
            copied.bytes += std::fs::copy(&pak, &target)?;
            copied.files += 1;
        }
    }
    Ok(copied)
}

fn copy_tree(from: &Path, to: &Path, copied: &mut SampleCopy) -> AppResult<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()), copied)?;
        }
    } else if meta.is_file() {
        copied.bytes += std::fs::copy(from, to)?;
        copied.files += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_at(dir: &Path) -> PathBuf {
        let s = dir.join("GameAnimationSample");
        std::fs::create_dir_all(s.join("Content/Characters/Anims")).unwrap();
        std::fs::create_dir_all(s.join("Content/MetaHumans")).unwrap();
        std::fs::create_dir_all(s.join("Content/GameStudioData")).unwrap();
        std::fs::create_dir_all(s.join("Config")).unwrap();
        std::fs::create_dir_all(s.join("DerivedDataCache")).unwrap();
        std::fs::write(s.join(SAMPLE_PROJECT), r#"{"FileVersion":3,"EngineAssociation":"5.8","Plugins":[]}"#).unwrap();
        std::fs::write(s.join("Config/DefaultEngine.ini"), "[/Script/Engine.RendererSettings]\nr.ReflectionMethod=1\n").unwrap();
        std::fs::write(s.join("Config/Notes.txt"), "not settings").unwrap();
        std::fs::write(s.join("Content/Characters/Anims/Walk.uasset"), vec![7u8; 1000]).unwrap();
        std::fs::write(s.join("Content/MetaHumans/BP_Kellan.uasset"), b"kellan").unwrap();
        std::fs::write(s.join("Content/GameStudioData/world.json"), b"{}").unwrap();
        std::fs::write(s.join("DerivedDataCache/Compressed.ddp"), b"cache").unwrap();
        s
    }

    fn project_at(dir: &Path) -> PathBuf {
        let root = dir.join("project");
        std::fs::create_dir_all(root.join("unreal/Content/GameStudioData")).unwrap();
        std::fs::write(root.join("unreal/StudioValley.uproject"), "{}").unwrap();
        std::fs::write(root.join("unreal/Content/GameStudioData/world.json"), b"ours").unwrap();
        root
    }

    #[test]
    fn finds_the_sample_where_the_launcher_puts_it() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(find_sample_in(dir.path()), None);
        let s = sample_at(dir.path());
        assert_eq!(find_sample_in(dir.path()), Some(s.clone()));
        // A renamed folder still counts; a folder without Content does not.
        std::fs::rename(&s, dir.path().join("MySample")).unwrap();
        std::fs::create_dir_all(dir.path().join("Empty")).unwrap();
        std::fs::write(dir.path().join("Empty").join(SAMPLE_PROJECT), "{}").unwrap();
        assert_eq!(find_sample_in(dir.path()), Some(dir.path().join("MySample")));
    }

    #[test]
    fn reads_only_the_sample_settings_files() {
        let dir = tempfile::tempdir().unwrap();
        let files = read_sample(&sample_at(dir.path())).unwrap();
        assert_eq!(files.engine_version.as_deref(), Some("5.8"));
        assert_eq!(files.config.keys().collect::<Vec<_>>(), vec!["DefaultEngine.ini"]);
        assert!(files.config["DefaultEngine.ini"].contains("r.ReflectionMethod=1"));
    }

    #[test]
    fn copies_the_content_and_cache_but_never_over_game_studio_data() {
        let dir = tempfile::tempdir().unwrap();
        let s = sample_at(dir.path());
        let root = project_at(dir.path());
        let copied = copy_sample(&s, &root, "unreal").unwrap();
        assert_eq!(copied, SampleCopy { files: 3, bytes: 1000 + 6 + 5 });
        assert_eq!(std::fs::read(root.join("unreal/Content/Characters/Anims/Walk.uasset")).unwrap().len(), 1000);
        assert_eq!(std::fs::read(root.join("unreal/Content/MetaHumans/BP_Kellan.uasset")).unwrap(), b"kellan");
        assert_eq!(std::fs::read(root.join("unreal/Content/GameStudioData/world.json")).unwrap(), b"ours");
        assert_eq!(std::fs::read(root.join("unreal/DerivedDataCache/Compressed.ddp")).unwrap(), b"cache");
        // Running it again copies nothing new.
        assert_eq!(copy_sample(&s, &root, "unreal").unwrap(), SampleCopy::default());
    }

    #[test]
    fn redoes_a_folder_whose_copy_stopped_halfway() {
        let dir = tempfile::tempdir().unwrap();
        let s = sample_at(dir.path());
        let root = project_at(dir.path());
        std::fs::create_dir_all(root.join("unreal/Content/.gamestudio-copy-MetaHumans")).unwrap();
        std::fs::write(root.join("unreal/Content/.gamestudio-copy-MetaHumans/half"), b"x").unwrap();
        copy_sample(&s, &root, "unreal").unwrap();
        assert!(!root.join("unreal/Content/.gamestudio-copy-MetaHumans").exists());
        assert!(!root.join("unreal/Content/MetaHumans/half").exists());
        assert!(root.join("unreal/Content/MetaHumans/BP_Kellan.uasset").is_file());
    }

    #[test]
    fn refuses_places_outside_a_game_studio_unreal_project() {
        let dir = tempfile::tempdir().unwrap();
        let s = sample_at(dir.path());
        let root = project_at(dir.path());
        assert!(copy_sample(&s, &root, "../elsewhere").is_err());
        assert!(copy_sample(&s, &root, "godot").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path(), root.join("linked")).unwrap();
            assert!(copy_sample(&s, &root, "linked").is_err());
        }
    }

    #[test]
    #[cfg(unix)]
    fn skips_symbolic_links_inside_the_sample() {
        let dir = tempfile::tempdir().unwrap();
        let s = sample_at(dir.path());
        std::os::unix::fs::symlink("/etc/hosts", s.join("Content/MetaHumans/hosts")).unwrap();
        let root = project_at(dir.path());
        copy_sample(&s, &root, "unreal").unwrap();
        assert!(std::fs::symlink_metadata(root.join("unreal/Content/MetaHumans/hosts")).is_err());
    }
}
