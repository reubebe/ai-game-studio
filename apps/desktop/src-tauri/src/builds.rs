//! Standalone builds: Godot export presets (mirrors `parseGodotPresets` / `planGodotExport` in
//! packages/project/src/export.ts) and the names Unity builds are written under.

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preset {
    pub name: String,
    pub platform: String,
    pub export_path: String,
    /// `binary_format/embed_pck=true` in the preset's options: the game's data is inside the program
    /// instead of in a .pck beside it.
    pub embed_pck: bool,
}

fn cfg_string(raw: &str) -> String {
    let raw = raw.trim();
    let Some(body) = raw.strip_prefix('"') else { return raw.to_string() };
    let mut out = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            }
            '"' => break,
            _ => out.push(c),
        }
    }
    out
}

/// Presets declared in export_presets.cfg (Godot's ConfigFile text format).
pub fn parse_presets(cfg: &str) -> Vec<Preset> {
    enum Section {
        Other,
        Preset(usize),
        Options(usize),
    }
    let mut presets: Vec<Preset> = Vec::new();
    // [preset.N] sections by N, so that [preset.N.options] finds its preset.
    let mut numbers: Vec<String> = Vec::new();
    let mut section = Section::Other;
    let is_number = |n: &str| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit());
    for raw in cfg.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            let inner = line.trim_start_matches('[').trim_end_matches(']');
            section = match inner.strip_prefix("preset.") {
                Some(n) if is_number(n) => {
                    presets.push(Preset { name: String::new(), platform: String::new(), export_path: String::new(), embed_pck: false });
                    numbers.push(n.to_string());
                    Section::Preset(presets.len() - 1)
                }
                Some(rest) => match rest.strip_suffix(".options").and_then(|n| numbers.iter().position(|x| x == n)) {
                    Some(i) => Section::Options(i),
                    None => Section::Other,
                },
                None => Section::Other,
            };
            continue;
        }
        if line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        match section {
            Section::Preset(i) => {
                let current = &mut presets[i];
                match key.trim() {
                    "name" => current.name = cfg_string(value),
                    "platform" => current.platform = cfg_string(value),
                    "export_path" => current.export_path = cfg_string(value),
                    _ => {}
                }
            }
            Section::Options(i) if key.trim() == "binary_format/embed_pck" => presets[i].embed_pck = value.trim() == "true",
            _ => {}
        }
    }
    presets
}

/// The project-relative path of a preset's .app, refusing anything that leaves the project folder.
/// `engine_dir` is the Godot project folder relative to the project root; Godot resolves
/// `export_path` from there.
pub fn app_path_in_project(engine_dir: &str, export_path: &str) -> AppResult<String> {
    export_file_in_project(engine_dir, export_path, ".app", "macOS", "a .app")
}

/// The project-relative path of a Web preset's page (Play here), with the same checks.
pub fn web_page_in_project(engine_dir: &str, export_path: &str) -> AppResult<String> {
    export_file_in_project(engine_dir, export_path, ".html", "Web", "an .html page")
}

/// The project-relative path of a Windows preset's program (mirrors planGodotDesktopExport in export.ts).
pub fn windows_exe_in_project(engine_dir: &str, export_path: &str) -> AppResult<String> {
    export_file_in_project(engine_dir, export_path, ".exe", "Windows", "a .exe file")
}

/// The project-relative path of a Linux preset's program, which may have any file name.
pub fn linux_program_in_project(engine_dir: &str, export_path: &str) -> AppResult<String> {
    export_file_in_project(engine_dir, export_path, "", "Linux", "a file")
}

fn export_file_in_project(engine_dir: &str, export_path: &str, suffix: &str, preset: &str, what: &str) -> AppResult<String> {
    let name = export_path.rsplit('/').next().unwrap_or("");
    if export_path.is_empty() || export_path.starts_with('/') || export_path.contains('\\') || name.is_empty() || name == "." || name == ".." || !name.ends_with(suffix) {
        return Err(AppError::Invalid(format!("The {preset} preset must export to {what} inside the project folder (it says \"{export_path}\")")));
    }
    let mut out: Vec<&str> = Vec::new();
    for part in engine_dir.split('/').chain(export_path.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                if out.pop().is_none() {
                    return Err(AppError::Denied(format!("The {preset} preset's export path leaves the project folder")));
                }
            }
            p => out.push(p),
        }
    }
    if out.last().map(|name| name.len() <= suffix.len()).unwrap_or(true) {
        return Err(AppError::Invalid(format!("The {preset} preset has no export file name")));
    }
    Ok(out.join("/"))
}

/// Whether files Godot imports (models, pictures, sounds) were added or changed under `assets/`
/// since Godot last imported them. A run (not the editor) loads only imported resources, so a model
/// dropped into the project after the first run would otherwise fail to load.
pub fn godot_needs_import(work: &std::path::Path) -> bool {
    const IMPORTED: [&str; 12] = ["glb", "gltf", "vrm", "png", "jpg", "jpeg", "webp", "svg", "ogg", "wav", "mp3", "hdr"];
    let dir = work.join("assets");
    if !dir.is_dir() {
        return false;
    }
    walkdir::WalkDir::new(&dir).follow_links(false).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()).any(|e| {
        let ext = e.path().extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase()).unwrap_or_default();
        if !IMPORTED.contains(&ext.as_str()) {
            return false;
        }
        let mut sidecar = e.path().as_os_str().to_owned();
        sidecar.push(".import");
        let modified = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        match (modified(e.path()), modified(std::path::Path::new(&sidecar))) {
            (Some(file), Some(import)) => file > import,
            _ => true,
        }
    })
}

/// Mirrors `bundleIdFor` in packages/project/src/export.ts.
pub fn bundle_id(project_id: &str) -> String {
    let slug: String = project_id.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let slug = slug.trim_matches('-');
    if slug.starts_with(|c: char| c.is_ascii_lowercase()) {
        format!("com.gamestudio.{slug}")
    } else {
        format!("com.gamestudio.game-{slug}")
    }
}

/// The app file name for a build. The webview passes the name it shows (exportAppName in
/// export.ts); it must be a single safe folder name ending in .app, otherwise the project id is used.
pub fn app_file_name(requested: Option<&str>, project_id: &str) -> String {
    match requested {
        Some(name) if name.ends_with(".app") && name.len() > 4 && crate::paths::is_safe_folder_name(name) => name.to_string(),
        _ => format!("{project_id}.app"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_assets_godot_has_not_imported_yet() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path();
        assert!(!godot_needs_import(work));
        std::fs::create_dir_all(work.join("assets/models")).unwrap();
        std::fs::write(work.join("assets/notes.txt"), "x").unwrap();
        assert!(!godot_needs_import(work));
        std::fs::write(work.join("assets/models/crate.glb"), "glb").unwrap();
        assert!(godot_needs_import(work));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(work.join("assets/models/crate.glb.import"), "[remap]").unwrap();
        assert!(!godot_needs_import(work));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(work.join("assets/models/crate.glb"), "glb v2").unwrap();
        assert!(godot_needs_import(work));
    }

    #[test]
    fn names_builds_like_the_typescript_side() {
        assert_eq!(bundle_id("sun-crystal-valley-3fa2c1"), "com.gamestudio.sun-crystal-valley-3fa2c1");
        assert_eq!(bundle_id("3d-game-0001"), "com.gamestudio.game-3d-game-0001");
        assert_eq!(app_file_name(Some("Sun Crystal Valley Unity.app"), "x-0001"), "Sun Crystal Valley Unity.app");
        for bad in ["../evil.app", "a/b.app", ".app", "Game.zip", ".hidden.app", " Game.app"] {
            assert_eq!(app_file_name(Some(bad), "valley-0001"), "valley-0001.app", "{bad}");
        }
        assert_eq!(app_file_name(None, "valley-0001"), "valley-0001.app");
    }

    #[test]
    fn parses_presets_like_the_typescript_side() {
        let cfg = "[preset.0]\nname=\"Web\"\nplatform=\"Web\"\nexport_path=\"build/index.html\"\n\n[preset.0.options]\nname=\"not a preset\"\n\n[preset.1]\n; comment=\"x\"\nname=\"My \\\"Mac\\\"\"\nplatform=\"macOS\"\nexport_path=\"../out/My Game.app\"\n";
        assert_eq!(
            parse_presets(cfg),
            vec![
                Preset { name: "Web".into(), platform: "Web".into(), export_path: "build/index.html".into(), embed_pck: false },
                Preset { name: "My \"Mac\"".into(), platform: "macOS".into(), export_path: "../out/My Game.app".into(), embed_pck: false },
            ]
        );
        assert!(parse_presets("[remap]\nname=\"x\"\n").is_empty());
    }

    #[test]
    fn reads_whether_a_preset_embeds_its_game_data() {
        // Options sections can come in any order and belong to the preset with the same number.
        let cfg = "[preset.3]\nname=\"Linux\"\nplatform=\"Linux\"\nexport_path=\"../exports/linux/G.x86_64\"\n\n[preset.7]\nname=\"PC\"\nplatform=\"Windows Desktop\"\nexport_path=\"../exports/windows/G.exe\"\n\n[preset.7.options]\n\nbinary_format/embed_pck=true\n\n[preset.3.options]\n\nbinary_format/embed_pck=false\n\n[preset.9.options]\nbinary_format/embed_pck=true\n";
        let presets = parse_presets(cfg);
        assert_eq!(presets.iter().map(|p| (p.name.as_str(), p.embed_pck)).collect::<Vec<_>>(), vec![("Linux", false), ("PC", true)]);
    }

    #[test]
    fn keeps_export_paths_inside_the_project() {
        assert_eq!(app_path_in_project("godot", "../exports/macos/Sun Valley.app").unwrap(), "exports/macos/Sun Valley.app");
        assert_eq!(app_path_in_project("godot", "build/Game.app").unwrap(), "godot/build/Game.app");
        for bad in ["../../Elsewhere.app", "/Applications/Game.app", "../exports/Game.zip", "", "..\\x.app", "../../../../tmp/x.app", "../.app"] {
            assert!(app_path_in_project("godot", bad).is_err(), "{bad}");
        }
        assert_eq!(web_page_in_project("godot", "../exports/web/index.html").unwrap(), "exports/web/index.html");
        for bad in ["../../site/index.html", "/tmp/index.html", "../exports/web/index.htm", "", "..\\web\\index.html", "../.html"] {
            assert!(web_page_in_project("godot", bad).is_err(), "{bad}");
        }
        assert_eq!(windows_exe_in_project("godot", "../exports/windows/Sun Valley.exe").unwrap(), "exports/windows/Sun Valley.exe");
        for bad in ["../../Elsewhere/Game.exe", "/tmp/Game.exe", "../exports/windows/Game.zip", "", "..\\w\\Game.exe", "../exports/windows/", "../.exe", "../../../.."] {
            assert!(windows_exe_in_project("godot", bad).is_err(), "{bad}");
        }
        assert_eq!(linux_program_in_project("godot", "../exports/linux/Sun Valley.x86_64").unwrap(), "exports/linux/Sun Valley.x86_64");
        assert_eq!(linux_program_in_project("godot", "../dist/linux/game").unwrap(), "dist/linux/game");
        for bad in ["../../outside/game", "/usr/local/bin/game", "", "../exports/linux/", "../..", "../dist/.."] {
            assert!(linux_program_in_project("godot", bad).is_err(), "{bad}");
        }
    }
}
