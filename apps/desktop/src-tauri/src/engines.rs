use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Godot release this studio's templates target. Other 4.x releases are listed but flagged.
pub const PINNED_GODOT: &str = "4.7.2";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstall {
    pub version: String,
    pub full_version: String,
    pub channel: String,
    pub flavor: String,
    pub executable: String,
    pub bundle: Option<String>,
    pub source: String,
    pub compatible: bool,
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub problem: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: String,
    pub label: String,
    /// "available", "unavailable" or "planned"
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineReport {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub installs: Vec<EngineInstall>,
    pub tools: Vec<ToolInfo>,
    pub capabilities: Vec<Capability>,
    pub official_url: String,
    pub notes: Vec<String>,
}

fn cap(id: &str, label: &str, status: &str, reason: Option<&str>) -> Capability {
    Capability { id: id.into(), label: label.into(), status: status.into(), reason: reason.map(String::from) }
}

/// Run a command and capture output, killing it after `timeout`.
pub fn run_with_timeout(program: &Path, args: &[&str], timeout: Duration) -> Result<(i32, String, String), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {}s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok((output.status.code().unwrap_or(-1), String::from_utf8_lossy(&output.stdout).to_string(), String::from_utf8_lossy(&output.stderr).to_string()))
}

/// Parse `4.7.2.stable.official.ed1daf0bf` or `4.8.beta3.mono.official.abc` into (version, channel, flavor).
pub fn parse_godot_version(text: &str) -> Option<(String, String, String)> {
    let line = text.lines().map(str::trim).find(|l| l.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))?;
    let parts: Vec<&str> = line.split('.').collect();
    let numeric: Vec<&str> = parts.iter().take_while(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())).cloned().collect();
    if numeric.len() < 2 {
        return None;
    }
    let version = numeric.join(".");
    let channel = parts.get(numeric.len()).map(|s| s.to_string()).unwrap_or_else(|| "unknown".into());
    let flavor = if parts.iter().any(|p| *p == "mono") { "mono" } else { "standard" };
    Some((version, channel, flavor.to_string()))
}

fn executable_in_bundle(bundle: &Path) -> Option<PathBuf> {
    let macos = bundle.join("Contents/MacOS");
    let preferred = macos.join("Godot");
    if preferred.is_file() {
        return Some(preferred);
    }
    std::fs::read_dir(&macos).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.is_file())
}

/// The main executable of an app bundle, named by CFBundleExecutable in its Info.plist.
pub fn bundle_executable(bundle: &Path) -> Option<PathBuf> {
    let plist = bundle.join("Contents/Info.plist");
    let out = Command::new("/usr/libexec/PlistBuddy").args(["-c", "Print :CFBundleExecutable"]).arg(&plist).stdin(Stdio::null()).output().ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || name.is_empty() || name.contains('/') || name.starts_with('.') {
        return None;
    }
    let exe = bundle.join("Contents/MacOS").join(name);
    exe.is_file().then_some(exe)
}

/// Where Godot reads export templates on macOS. Godot 4.7.2 ignores XDG_DATA_HOME for this
/// (checked by exporting with it pointed at an empty folder), so the studio does too.
pub fn godot_templates_root() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/Godot/export_templates"))
}

/// Godot's folder name for one release's templates, such as `4.7.2.stable` or `4.7.2.stable.mono`.
pub fn templates_folder(install: &EngineInstall) -> String {
    let base = format!("{}.{}", install.version, install.channel);
    if install.flavor == "mono" {
        format!("{base}.mono")
    } else {
        base
    }
}

/// Installed means the folder's version.txt names this release and the macOS template is there.
pub fn templates_ready(root: &Path, folder: &str) -> bool {
    let dir = root.join(folder);
    std::fs::read_to_string(dir.join("version.txt")).map(|v| v.trim() == folder).unwrap_or(false) && dir.join("macos.zip").is_file()
}

/// The single-threaded web template that Play here exports with (it needs no cross-origin isolation).
pub const WEB_TEMPLATE: &str = "web_nothreads_debug.zip";

/// Templates installed, including the web one.
pub fn web_templates_ready(root: &Path, folder: &str) -> bool {
    templates_ready(root, folder) && root.join(folder).join(WEB_TEMPLATE).is_file()
}

/// The 64-bit x86 release templates that Export for Windows and Export for Linux build with.
pub const WINDOWS_TEMPLATE: &str = "windows_release_x86_64.exe";
pub const LINUX_TEMPLATE: &str = "linux_release.x86_64";

/// Templates installed, including `file`.
pub fn template_file_ready(root: &Path, folder: &str, file: &str) -> bool {
    templates_ready(root, folder) && root.join(folder).join(file).is_file()
}

/// The install the studio runs: the configured one, else a compatible one, else the first found.
pub fn preferred_install(installs: &[EngineInstall]) -> Option<&EngineInstall> {
    installs.iter().find(|i| i.source == "configured").or_else(|| installs.iter().find(|i| i.compatible)).or_else(|| installs.first())
}

fn bundles_in(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "app").unwrap_or(false) && p.file_name().map(|n| n.to_string_lossy().starts_with(prefix)).unwrap_or(false))
        .collect();
    out.sort();
    out
}

fn find_on_path(names: &[&str]) -> Vec<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else { return vec![] };
    let mut out = Vec::new();
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                out.push(candidate);
            }
        }
    }
    out
}

/// Development builds also look in the repository's `.engines` folder (gitignored).
pub fn development_engines_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        option_env!("CARGO_MANIFEST_DIR").map(|d| Path::new(d).join("../../../.engines"))
    } else {
        None
    }
}

pub fn godot_candidates(data_dir: &Path, configured: Option<&str>) -> Vec<(PathBuf, Option<PathBuf>, &'static str)> {
    let mut out: Vec<(PathBuf, Option<PathBuf>, &'static str)> = Vec::new();
    let push_bundle = |bundle: PathBuf, source: &'static str, out: &mut Vec<(PathBuf, Option<PathBuf>, &'static str)>| {
        if let Some(exe) = executable_in_bundle(&bundle) {
            out.push((exe, Some(bundle), source));
        }
    };
    if let Some(c) = configured {
        let p = PathBuf::from(c);
        if p.extension().map(|x| x == "app").unwrap_or(false) {
            push_bundle(p, "configured", &mut out);
        } else if p.is_file() {
            out.push((p, None, "configured"));
        }
    }
    for root in [Some(data_dir.join("engines/godot")), development_engines_dir().map(|d| d.join("godot"))].into_iter().flatten() {
        let source = if root.starts_with(data_dir) { "managed" } else { "development" };
        if let Ok(versions) = std::fs::read_dir(&root) {
            let mut dirs: Vec<PathBuf> = versions.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
            dirs.sort();
            for d in dirs {
                for b in bundles_in(&d, "Godot") {
                    push_bundle(b, source, &mut out);
                }
            }
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    for dir in [Some(PathBuf::from("/Applications")), home.map(|h| h.join("Applications"))].into_iter().flatten() {
        for b in bundles_in(&dir, "Godot") {
            push_bundle(b, "applications", &mut out);
        }
    }
    for p in find_on_path(&["godot", "godot4"]) {
        out.push((p, None, "path"));
    }
    out
}

pub fn discover_godot(data_dir: &Path, configured: Option<&str>, templates_root: Option<&Path>) -> EngineReport {
    let mut installs: Vec<EngineInstall> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut problems = Vec::new();
    for (exe, bundle, source) in godot_candidates(data_dir, configured) {
        let canonical = exe.canonicalize().unwrap_or(exe.clone());
        if !seen.insert(canonical.clone()) {
            continue;
        }
        match run_with_timeout(&exe, &["--version"], Duration::from_secs(15)) {
            Ok((0, out, _)) => {
                if let Some((version, channel, flavor)) = parse_godot_version(&out) {
                    let compatible = version.starts_with("4.7") && channel == "stable";
                    let note = if version == PINNED_GODOT && channel == "stable" {
                        None
                    } else if compatible {
                        Some(format!("Templates target {PINNED_GODOT}; this 4.7 release should work."))
                    } else {
                        Some(format!("Templates target Godot {PINNED_GODOT}; {version} {channel} has not been tested."))
                    };
                    installs.push(EngineInstall {
                        version,
                        full_version: out.trim().lines().last().unwrap_or("").to_string(),
                        channel,
                        flavor,
                        executable: canonical.to_string_lossy().to_string(),
                        bundle: bundle.map(|b| b.to_string_lossy().to_string()),
                        source: source.into(),
                        compatible,
                        note,
                    });
                } else {
                    problems.push(format!("{} did not report a Godot version", exe.display()));
                }
            }
            Ok((code, _, err)) => problems.push(format!("{} exited with {code}: {}", exe.display(), err.lines().next().unwrap_or(""))),
            Err(e) => problems.push(format!("{}: {e}", exe.display())),
        }
    }
    let has = !installs.is_empty();
    let reason_missing = if has { None } else { Some("Install Godot first (official download, with your approval) or locate an existing copy.") };
    let mut notes = vec![
        "Godot is MIT-licensed. Downloads come only from github.com/godotengine/godot-builds and are checked against the release's SHA-512 list and Apple code signature.".to_string(),
        "Export templates come from the same release page, are checked against the same SHA-512 list, and go where Godot looks for them (~/Library/Application Support/Godot/export_templates).".to_string(),
    ];
    notes.extend(problems);
    let export_label = "Export macOS builds (universal app, ad-hoc signed)";
    let play_web_label = "Play inside Game Studio (web build)";
    let mut tools = Vec::new();
    let chosen = preferred_install(&installs);
    let play_web = match (chosen, templates_root) {
        (Some(install), Some(root)) => {
            let folder = templates_folder(install);
            if web_templates_ready(root, &folder) {
                cap("play-web", play_web_label, "available", None)
            } else if templates_ready(root, &folder) {
                Capability { id: "play-web".into(), label: play_web_label.into(), status: "unavailable".into(), reason: Some(format!("The {folder} export templates have no {WEB_TEMPLATE}. Reinstall them from this card.")) }
            } else {
                Capability { id: "play-web".into(), label: play_web_label.into(), status: "unavailable".into(), reason: Some(format!("Needs the {folder} export templates: about 1.3 GB to download, 1.9 GB on disk. Install them from this card.")) }
            }
        }
        _ => cap("play-web", play_web_label, "unavailable", Some(reason_missing.unwrap_or("Could not find your home folder."))),
    };
    let export = match (chosen, templates_root) {
        (Some(install), Some(root)) => {
            let folder = templates_folder(install);
            let ready = templates_ready(root, &folder);
            tools.push(ToolInfo { name: "Export templates".into(), found: ready, version: Some(folder.clone()), path: ready.then(|| root.join(&folder).to_string_lossy().to_string()), problem: None });
            if ready {
                cap("export", export_label, "available", None)
            } else {
                Capability { id: "export".into(), label: export_label.into(), status: "unavailable".into(), reason: Some(format!("Needs the {folder} export templates: about 1.3 GB to download, 1.9 GB on disk. Install them from this card.")) }
            }
        }
        _ => cap("export", export_label, "unavailable", Some(reason_missing.unwrap_or("Could not find your home folder."))),
    };
    // Windows and Linux builds: the 64-bit x86 template from the same archive. Their programs cannot run on a
    // Mac, so the studio checks the exported game data with Godot here (see plan_godot_export in lib.rs).
    let desktop = |id: &str, label: &str, file: &str| match (chosen, templates_root) {
        (Some(install), Some(root)) => {
            let folder = templates_folder(install);
            if template_file_ready(root, &folder, file) {
                cap(id, label, "available", None)
            } else if templates_ready(root, &folder) {
                Capability { id: id.into(), label: label.into(), status: "unavailable".into(), reason: Some(format!("The {folder} export templates have no {file}. Reinstall them from this card.")) }
            } else {
                Capability { id: id.into(), label: label.into(), status: "unavailable".into(), reason: Some(format!("Needs the {folder} export templates: about 1.3 GB to download, 1.9 GB on disk. Install them from this card.")) }
            }
        }
        _ => cap(id, label, "unavailable", Some(reason_missing.unwrap_or("Could not find your home folder."))),
    };
    let export_windows = desktop("export-windows", "Export Windows builds (64-bit .exe; the game data is self-tested here)", WINDOWS_TEMPLATE);
    let export_linux = desktop("export-linux", "Export Linux builds (64-bit x86; the game data is self-tested here)", LINUX_TEMPLATE);
    let official = chosen.map(|i| i.channel == "stable" && i.flavor == "standard").unwrap_or(false);
    EngineReport {
        id: "godot".into(),
        name: "Godot".into(),
        summary: format!("Primary engine. Templates target Godot {PINNED_GODOT} stable."),
        installs,
        tools,
        capabilities: vec![
            cap("detect", "Detect installed versions", "available", None),
            cap("install", "Install the official release", "available", None),
            cap("open-editor", "Open projects in the Godot editor", if has { "available" } else { "unavailable" }, reason_missing),
            cap("run", "Run games with live output", if has { "available" } else { "unavailable" }, reason_missing),
            cap("smoke-test", "Headless self-test", if has { "available" } else { "unavailable" }, reason_missing),
            cap(
                "install-templates",
                "Install export templates (official release)",
                if official { "available" } else { "unavailable" },
                if official { None } else if has { Some("Official templates exist only for standard stable releases.") } else { reason_missing },
            ),
            export,
            export_windows,
            export_linux,
            play_web,
        ],
        official_url: "https://godotengine.org/download/".into(),
        notes,
    }
}

fn plist_version(app: &Path) -> Option<String> {
    let plist = app.join("Contents/Info.plist");
    let out = Command::new("/usr/libexec/PlistBuddy").args(["-c", "Print CFBundleShortVersionString"]).arg(&plist).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

fn tool(name: &str, path: Option<PathBuf>, version: Option<String>, problem: Option<String>) -> ToolInfo {
    ToolInfo { name: name.into(), found: path.is_some(), version, path: path.map(|p| p.to_string_lossy().to_string()), problem }
}

/// The Unity release the studio's Unity template was built and tested with.
pub const TESTED_UNITY: &str = "6000.6.9f1";

fn unity_version_ok(v: &str) -> bool {
    let mut parts = v.splitn(3, '.');
    let (Some(year), Some(minor), Some(rest)) = (parts.next(), parts.next(), parts.next()) else { return false };
    let digits = |x: &str| !x.is_empty() && x.chars().all(|c| c.is_ascii_digit());
    let split = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    let (patch, tail) = rest.split_at(split);
    digits(year) && year.len() == 4 && digits(minor) && digits(patch) && tail.len() >= 2 && "abfpc".contains(&tail[..1]) && digits(&tail[1..])
}

/// Where Unity keeps an activated licence (entitlement file for Unity Hub sign-in, or a serial licence).
pub fn unity_licence_files() -> Vec<PathBuf> {
    let mut files = vec![PathBuf::from("/Library/Application Support/Unity/Unity_lic.ulf")];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        files.push(home.join("Library/Unity/licenses/UnityEntitlementLicense.xml"));
        files.push(home.join("Library/Application Support/Unity/Unity_lic.ulf"));
    }
    files
}

pub fn discover_unity() -> EngineReport {
    let mut editor_dirs = vec![PathBuf::from("/Applications/Unity/Hub/Editor")];
    if let Some(home) = std::env::var_os("HOME") {
        let cfg = PathBuf::from(home).join("Library/Application Support/UnityHub/secondaryInstallPath.json");
        if let Ok(text) = std::fs::read_to_string(cfg) {
            if let Ok(serde_json::Value::String(p)) = serde_json::from_str::<serde_json::Value>(&text) {
                if !p.is_empty() {
                    editor_dirs.push(PathBuf::from(p));
                }
            }
        }
    }
    discover_unity_at(&editor_dirs, Path::new("/Applications/Unity Hub.app"), &unity_licence_files())
}

pub fn discover_unity_at(editor_dirs: &[PathBuf], hub: &Path, licences: &[PathBuf]) -> EngineReport {
    let hub_found = hub.is_dir();
    let mut installs = Vec::new();
    let mut can_build_mac = false;
    for dir in editor_dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        let mut versions: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        versions.sort();
        for folder in versions {
            let version = folder.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let app = folder.join("Unity.app");
            let exe = app.join("Contents/MacOS/Unity");
            if !unity_version_ok(&version) || !exe.is_file() {
                continue;
            }
            let mac = folder.join("PlaybackEngines/MacStandaloneSupport").is_dir();
            let compatible = version.starts_with("6000.");
            can_build_mac |= mac && compatible;
            let mut notes = Vec::new();
            if !compatible {
                notes.push(format!("The Unity template targets Unity 6 (tested with {TESTED_UNITY}); {version} is untested."));
            } else if version != TESTED_UNITY {
                notes.push(format!("Tested with {TESTED_UNITY}; other Unity 6 releases should work."));
            }
            if !mac {
                notes.push("No Mac Build Support module: add it in Unity Hub to build apps.".into());
            }
            installs.push(EngineInstall {
                version: version.clone(),
                full_version: version,
                channel: "release".into(),
                flavor: "standard".into(),
                executable: exe.to_string_lossy().to_string(),
                bundle: Some(app.to_string_lossy().to_string()),
                source: "unity-hub".into(),
                compatible,
                note: (!notes.is_empty()).then(|| notes.join(" ")),
            });
        }
    }
    let licence = licences.iter().find(|p| p.is_file());
    let has = installs.iter().any(|i| i.compatible);
    let no_editor = "Install Unity 6 with Unity Hub (free Personal licence).";
    let build_reason = if !has {
        Some(no_editor)
    } else if !can_build_mac {
        Some("Add the Mac Build Support module to Unity 6 in Unity Hub.")
    } else if licence.is_none() {
        Some("Sign in to Unity Hub and activate a licence; batch builds need one.")
    } else {
        None
    };
    EngineReport {
        id: "unity".into(),
        name: "Unity".into(),
        summary: format!("Unity 6 projects from the studio's 3D template: open, build for macOS and self-test. Tested with {TESTED_UNITY}."),
        installs,
        tools: vec![
            tool("Unity Hub", hub_found.then(|| hub.to_path_buf()), if hub_found { plist_version(hub) } else { None }, None),
            ToolInfo { name: "Unity licence".into(), found: licence.is_some(), version: None, path: licence.map(|p| p.to_string_lossy().to_string()), problem: licence.is_none().then(|| "No activated licence found".to_string()) },
        ],
        capabilities: vec![
            cap("detect", "Detect Unity Hub, editors and modules", "available", None),
            cap("open-hub", "Open Unity Hub", if hub_found { "available" } else { "unavailable" }, if hub_found { None } else { Some("Unity Hub is not installed.") }),
            cap("install", "Install Unity (official Unity Hub)", "available", Some("Opens unity.com/download in your browser. Unity's licence terms apply.")),
            cap("projects", "Create Unity projects (3D exploration template)", "available", None),
            cap("open-editor", "Open projects in the Unity editor", if has { "available" } else { "unavailable" }, if has { None } else { Some(no_editor) }),
            cap("build", "Build macOS apps (Apple silicon) and run their self-test", if build_reason.is_none() { "available" } else { "unavailable" }, build_reason),
            cap("rules", "Run studio rules inside Unity", "available", Some("Every Unity project ships the C# rule runtime, checked against the same conformance fixtures as Godot and the studio.")),
        ],
        official_url: "https://unity.com/download".into(),
        notes: vec![
            "Game Studio never installs Unity silently or accepts its licence for you.".into(),
            "Unity 6.6 deprecates Intel Mac builds, so Unity builds here target Apple silicon only.".into(),
        ],
    }
}

/// What Unreal needs from Xcode on a Mac. Unreal treats the Command Line Tools as "no Xcode" and
/// compiles Metal shaders with Xcode's separately installed Metal toolchain.
#[derive(Debug, Clone, Default)]
pub struct XcodeState {
    pub app: Option<PathBuf>,
    pub version: Option<String>,
    /// The developer folder xcode-select reports (it honours DEVELOPER_DIR).
    pub selected: Option<String>,
    pub metal: bool,
}

pub const XCODE_APP: &str = "/Applications/Xcode.app";
pub const SELECT_XCODE: &str = "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer";
pub const GET_METAL: &str = "xcodebuild -downloadComponent MetalToolchain";

pub fn xcode_state() -> XcodeState {
    let app = Some(PathBuf::from(XCODE_APP)).filter(|a| a.is_dir());
    let version = app.as_deref().and_then(plist_version);
    let selected = Command::new("/usr/bin/xcode-select").arg("--print-path").stdin(Stdio::null()).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let metal = app.as_ref().map(|a| {
        Command::new("/usr/bin/xcrun").args(["metal", "--version"]).env("DEVELOPER_DIR", a.join("Contents/Developer")).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
    });
    XcodeState { app, version, selected, metal: metal.unwrap_or(false) }
}

impl XcodeState {
    /// Unreal checks the system-wide selection, so the Command Line Tools there means "Xcode Not Found".
    pub fn selected_is_xcode(&self) -> bool {
        self.selected.as_deref().map(|p| p.contains(".app/Contents/Developer")).unwrap_or(false)
    }

    /// Why Unreal cannot compile shaders yet, or None when Xcode and its Metal toolchain are ready.
    pub fn unreal_blocker(&self) -> Option<&'static str> {
        if self.app.is_none() {
            Some("Unreal needs Xcode (Mac App Store).")
        } else if !self.selected_is_xcode() {
            Some("Select Xcode first: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer")
        } else if !self.metal {
            Some("Install Xcode's Metal toolchain first: xcodebuild -downloadComponent MetalToolchain")
        } else {
            None
        }
    }
}

/// The Unreal release the studio's Unreal template was built and tested with.
pub const TESTED_UNREAL: &str = "5.8";

fn xcode_tools(x: &XcodeState) -> Vec<ToolInfo> {
    let xcode_problem = if x.app.is_none() {
        Some("Unreal needs Xcode (Mac App Store).".to_string())
    } else if !x.selected_is_xcode() {
        Some(format!("The selected developer folder is {}, so Unreal reports \"Xcode Not Found\". Select Xcode (needs your admin password): {SELECT_XCODE}", x.selected.as_deref().unwrap_or("not set")))
    } else {
        None
    };
    vec![
        ToolInfo { name: "Xcode".into(), found: x.app.is_some(), version: x.version.clone(), path: x.app.as_ref().map(|a| a.to_string_lossy().to_string()), problem: xcode_problem },
        ToolInfo {
            name: "Metal toolchain".into(),
            found: x.metal,
            version: None,
            path: None,
            problem: (!x.metal).then(|| format!("Unreal compiles shaders with it. Install it with: {GET_METAL}")),
        },
    ]
}

/// The editor app inside an Unreal Engine install folder, when the install is complete.
fn unreal_editor(location: &Path) -> Option<PathBuf> {
    let app = location.join("Engine/Binaries/Mac/UnrealEditor.app");
    app.join("Contents/MacOS/UnrealEditor").is_file().then_some(app)
}

pub fn discover_unreal() -> EngineReport {
    let dat = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat"));
    discover_unreal_at(dat.as_deref(), Path::new("/Users/Shared/Epic Games"), Path::new("/Applications/Epic Games Launcher.app"), &xcode_state(), crate::unreal_sample::find_sample())
}

/// Installs come from the launcher's own list and from the default shared folder. A folder only
/// counts once UnrealEditor.app exists; the launcher creates UE_x.y as soon as a download starts.
pub fn discover_unreal_at(dat: Option<&Path>, shared: &Path, launcher: &Path, xcode: &XcodeState, sample: Option<PathBuf>) -> EngineReport {
    let launcher_found = launcher.is_dir();
    let mut candidates: Vec<(String, String, PathBuf, &'static str)> = Vec::new();
    if let Some(text) = dat.and_then(|d| std::fs::read_to_string(d).ok()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            for item in v.get("InstallationList").and_then(|l| l.as_array()).cloned().unwrap_or_default() {
                let app = item.get("AppName").and_then(|a| a.as_str()).unwrap_or("");
                let loc = item.get("InstallLocation").and_then(|a| a.as_str()).unwrap_or("");
                if app.starts_with("UE_") && !loc.is_empty() {
                    let full = item.get("AppVersion").and_then(|a| a.as_str()).unwrap_or(app).to_string();
                    candidates.push((app.trim_start_matches("UE_").to_string(), full, PathBuf::from(loc), "epic-launcher"));
                }
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(shared) {
        let mut names: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        names.sort();
        for path in names {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name.starts_with("UE_") && path.is_dir() {
                candidates.push((name.trim_start_matches("UE_").to_string(), name.clone(), path, "shared-folder"));
            }
        }
    }
    let mut installs = Vec::new();
    let mut notes = vec!["Game Studio never installs Unreal Engine silently or accepts its EULA for you.".to_string()];
    let mut seen = std::collections::HashSet::new();
    for (version, full, location, source) in candidates {
        if !seen.insert(location.clone()) {
            continue;
        }
        match unreal_editor(&location) {
            Some(app) => installs.push(EngineInstall {
                compatible: version.starts_with("5."),
                note: if version == TESTED_UNREAL {
                    None
                } else if version.starts_with("5.") {
                    Some(format!("The Unreal template was built and tested with {TESTED_UNREAL}; its build files name that release."))
                } else {
                    Some("The Unreal template targets Unreal Engine 5.".into())
                },
                version,
                full_version: full,
                channel: "release".into(),
                flavor: "standard".into(),
                executable: app.join("Contents/MacOS/UnrealEditor").to_string_lossy().to_string(),
                bundle: Some(app.to_string_lossy().to_string()),
                source: source.into(),
            }),
            None => notes.push(format!("{} is not a finished install (no UnrealEditor.app yet). Finish or resume it in the Epic Games Launcher.", location.display())),
        }
    }
    let has = installs.iter().any(|i| i.compatible);
    let blocker = if has { xcode.unreal_blocker() } else { Some("Install Unreal Engine 5 from the Epic Games Launcher.") };
    let ready = if blocker.is_none() { "available" } else { "unavailable" };
    EngineReport {
        id: "unreal".into(),
        name: "Unreal Engine".into(),
        summary: format!("Unreal Engine 5 projects from the studio's 3D template: compile, open, package for macOS and self-test. Tested with {TESTED_UNREAL}."),
        installs,
        tools: [vec![tool("Epic Games Launcher", launcher_found.then(|| launcher.to_path_buf()), if launcher_found { plist_version(launcher) } else { None }, None)], xcode_tools(xcode)].concat(),
        capabilities: vec![
            cap("detect", "Detect the launcher, engine versions and the Xcode parts Unreal needs", "available", None),
            cap("open-launcher", "Open the Epic Games Launcher", if launcher_found { "available" } else { "unavailable" }, if launcher_found { None } else { Some("The Epic Games Launcher is not installed.") }),
            cap("install", "Install Unreal Engine (official launcher)", "available", Some("Opens Epic's official download page in your browser.")),
            cap("projects", "Create Unreal projects (3D exploration template)", "available", None),
            Capability {
                id: "animation-sample".into(),
                label: "Realistic people: Epic's Game Animation Sample (motion matching and a MetaHuman) for the realistic template".into(),
                status: if sample.is_some() { "available" } else { "unavailable" }.into(),
                reason: Some(match &sample {
                    Some(path) => format!("Found in {}. New realistic projects copy its content.", path.display()),
                    None => crate::unreal_sample::HOW_TO.to_string(),
                }),
            },
            cap("open-editor", "Compile the C++ module and open projects in the Unreal editor", ready, blocker),
            cap("build", "Package macOS apps (Apple silicon) and run their self-test", ready, blocker),
            cap("rules", "Run studio rules inside Unreal", "available", Some("Every Unreal project ships the C++ rule runtime, checked against the same conformance fixtures as Godot and the studio.")),
        ],
        official_url: "https://www.unrealengine.com/download".into(),
        notes,
    }
}

fn first_line_version(program: &str, args: &[&str]) -> (Option<PathBuf>, Option<String>, Option<String>) {
    let located = find_on_path(&[program]).into_iter().next().or_else(|| {
        let p = PathBuf::from(format!("/usr/bin/{program}"));
        p.is_file().then_some(p)
    });
    let Some(path) = located else { return (None, None, None) };
    match run_with_timeout(&path, args, Duration::from_secs(10)) {
        Ok((0, out, err)) => {
            let text = if out.trim().is_empty() { err } else { out };
            (Some(path), text.lines().next().map(|l| l.trim().to_string()), None)
        }
        Ok((code, _, err)) => (Some(path), None, Some(format!("exited with {code}: {}", err.lines().next().unwrap_or("").trim()))),
        Err(e) => (Some(path), None, Some(e)),
    }
}

fn sfml_version() -> (Option<PathBuf>, Option<String>) {
    for prefix in ["/opt/homebrew/include/SFML", "/usr/local/include/SFML"] {
        let config = Path::new(prefix).join("Config.hpp");
        if let Ok(text) = std::fs::read_to_string(&config) {
            let get = |key: &str| text.lines().find(|l| l.contains(key)).and_then(|l| l.split_whitespace().last()).map(String::from);
            let v = match (get("SFML_VERSION_MAJOR"), get("SFML_VERSION_MINOR"), get("SFML_VERSION_PATCH")) {
                (Some(a), Some(b), Some(c)) => Some(format!("{a}.{b}.{c}")),
                _ => None,
            };
            return (Some(PathBuf::from(prefix)), v);
        }
    }
    (None, None)
}

/// Find a CMake that actually runs. A broken shim earlier on PATH (for example a pip-installed
/// script whose Python was removed) is reported, and a working Homebrew copy is used instead.
pub fn working_cmake() -> (Option<PathBuf>, Option<String>, Vec<String>) {
    let mut candidates = find_on_path(&["cmake"]);
    for p in ["/opt/homebrew/bin/cmake", "/usr/local/bin/cmake", "/Applications/CMake.app/Contents/bin/cmake"] {
        candidates.push(PathBuf::from(p));
    }
    let mut problems = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for c in candidates {
        if !c.is_file() || !seen.insert(c.clone()) {
            continue;
        }
        match run_with_timeout(&c, &["--version"], Duration::from_secs(10)) {
            Ok((0, out, _)) => return (Some(c), out.lines().next().map(|l| l.trim().to_string()), problems),
            Ok((code, _, err)) => problems.push(format!("{} does not run (exit {code}: {})", c.display(), err.lines().next().unwrap_or("").trim())),
            Err(e) => problems.push(format!("{} does not run: {e}", c.display())),
        }
    }
    (None, None, problems)
}

pub fn discover_cpp() -> EngineReport {
    let (clang_path, clang_version, clang_problem) = first_line_version("clang++", &["--version"]);
    let (cmake_path, cmake_version, cmake_problems) = working_cmake();
    let (sfml_path, sfml_ver) = sfml_version();
    let opengl = Path::new("/System/Library/Frameworks/OpenGL.framework").is_dir();
    let compiler_ok = clang_path.is_some() && clang_problem.is_none();
    let can_build = compiler_ok && cmake_path.is_some() && sfml_path.is_some();
    let build_reason = if can_build { None } else if !compiler_ok { Some("Install the Xcode Command Line Tools: xcode-select --install") } else if cmake_path.is_none() { Some("No working CMake found. Install it with: brew install cmake") } else { Some("SFML is not installed. Install it with: brew install sfml") };
    let mut notes = vec!["SFML and CMake install through Homebrew (brew install sfml cmake). Game Studio does not run installers for you.".to_string()];
    notes.extend(cmake_problems.iter().map(|p| format!("Skipped a broken CMake: {p}")));
    EngineReport {
        id: "cpp".into(),
        name: "C++ / SFML / OpenGL".into(),
        summary: "Native C++ projects with SFML: configure, build, test and run through CMake.".into(),
        installs: vec![],
        tools: vec![
            tool("clang++", clang_path, clang_version, clang_problem),
            ToolInfo { name: "CMake".into(), found: cmake_path.is_some(), version: cmake_version, path: cmake_path.map(|p| p.to_string_lossy().to_string()), problem: None },
            ToolInfo { name: "SFML".into(), found: sfml_path.is_some(), version: sfml_ver, path: sfml_path.map(|p| p.to_string_lossy().to_string()), problem: None },
            ToolInfo { name: "OpenGL framework".into(), found: opengl, version: None, path: opengl.then(|| "/System/Library/Frameworks/OpenGL.framework".to_string()), problem: opengl.then(|| "Deprecated by Apple since macOS 10.14; still available.".to_string()) },
        ],
        capabilities: vec![
            cap("detect", "Detect compiler, CMake and SFML", "available", None),
            cap("compile", "Compile C++", if compiler_ok { "available" } else { "unavailable" }, if compiler_ok { None } else { Some("Install the Xcode Command Line Tools: xcode-select --install") }),
            cap("sfml-template", "SFML starter project (build, test, run)", if can_build { "available" } else { "unavailable" }, build_reason),
        ],
        official_url: "https://www.sfml-dev.org/download/".into(),
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_godot_version_strings() {
        assert_eq!(parse_godot_version("4.7.2.stable.official.ed1daf0bf\n"), Some(("4.7.2".into(), "stable".into(), "standard".into())));
        assert_eq!(parse_godot_version("4.8.beta3.mono.official.abc"), Some(("4.8".into(), "beta3".into(), "mono".into())));
        assert_eq!(parse_godot_version("Godot Engine v4.7.2\n4.7.2.stable.official.x"), Some(("4.7.2".into(), "stable".into(), "standard".into())));
        assert_eq!(parse_godot_version("not a version"), None);
    }

    #[test]
    fn discovers_a_fake_godot_and_reports_problems() {
        let data = tempfile::tempdir().unwrap();
        let bundle = data.path().join("engines/godot/4.7.2-stable/Godot.app/Contents/MacOS");
        std::fs::create_dir_all(&bundle).unwrap();
        let exe = bundle.join("Godot");
        std::fs::write(&exe, "#!/bin/sh\necho 4.7.2.stable.official.test\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let broken = data.path().join("broken");
        std::fs::write(&broken, "#!/bin/sh\necho oops >&2\nexit 3\n").unwrap();
        std::fs::set_permissions(&broken, std::fs::Permissions::from_mode(0o755)).unwrap();

        let templates = data.path().join("export_templates");
        let report = discover_godot(data.path(), Some(broken.to_str().unwrap()), Some(&templates));
        let managed = report.installs.iter().find(|i| i.source == "managed").expect("managed install found");
        assert_eq!(managed.version, "4.7.2");
        assert!(managed.compatible);
        assert!(managed.note.is_none());
        assert!(report.notes.iter().any(|n| n.contains("exited with 3")));
        let status = |r: &EngineReport, id: &str| r.capabilities.iter().find(|c| c.id == id).unwrap().status.clone();
        assert_eq!(status(&report, "run"), "available");
        assert_eq!(status(&report, "install-templates"), "available");
        assert_eq!(status(&report, "export"), "unavailable");
        assert_eq!(status(&report, "export-windows"), "unavailable");
        assert!(!report.tools.iter().find(|t| t.name == "Export templates").unwrap().found);

        // Templates for another release do not count; the matching folder does.
        std::fs::create_dir_all(templates.join("4.7.2.stable")).unwrap();
        std::fs::write(templates.join("4.7.2.stable/version.txt"), "4.7.1.stable\n").unwrap();
        std::fs::write(templates.join("4.7.2.stable/macos.zip"), "x").unwrap();
        assert_eq!(status(&discover_godot(data.path(), None, Some(&templates)), "export"), "unavailable");
        std::fs::write(templates.join("4.7.2.stable/version.txt"), "4.7.2.stable\n").unwrap();
        let ready = discover_godot(data.path(), None, Some(&templates));
        assert_eq!(status(&ready, "export"), "available");
        // Play here also needs the single-threaded web template.
        assert_eq!(status(&ready, "play-web"), "unavailable");
        assert!(ready.capabilities.iter().find(|c| c.id == "play-web").unwrap().reason.as_deref().unwrap().contains(WEB_TEMPLATE));
        std::fs::write(templates.join("4.7.2.stable").join(WEB_TEMPLATE), "x").unwrap();
        assert_eq!(status(&discover_godot(data.path(), None, Some(&templates)), "play-web"), "available");
        // Windows and Linux exports need their own 64-bit templates.
        assert_eq!(status(&ready, "export-windows"), "unavailable");
        assert!(ready.capabilities.iter().find(|c| c.id == "export-linux").unwrap().reason.as_deref().unwrap().contains(LINUX_TEMPLATE));
        std::fs::write(templates.join("4.7.2.stable").join(WINDOWS_TEMPLATE), "x").unwrap();
        std::fs::write(templates.join("4.7.2.stable").join(LINUX_TEMPLATE), "x").unwrap();
        let desktop = discover_godot(data.path(), None, Some(&templates));
        assert_eq!((status(&desktop, "export-windows").as_str(), status(&desktop, "export-linux").as_str()), ("available", "available"));
        assert_eq!(ready.tools[0].version.as_deref(), Some("4.7.2.stable"));
    }

    #[test]
    fn names_template_folders_like_godot() {
        let install = |version: &str, channel: &str, flavor: &str| EngineInstall { version: version.into(), full_version: String::new(), channel: channel.into(), flavor: flavor.into(), executable: String::new(), bundle: None, source: "path".into(), compatible: true, note: None };
        assert_eq!(templates_folder(&install("4.7.2", "stable", "standard")), "4.7.2.stable");
        assert_eq!(templates_folder(&install("4.7", "stable", "mono")), "4.7.stable.mono");
        assert_eq!(templates_folder(&install("4.8", "beta3", "standard")), "4.8.beta3");
    }

    #[test]
    fn finds_the_executable_named_in_a_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("My Game.app");
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(bundle.join("Contents/MacOS/Sun Valley"), "").unwrap();
        let plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>CFBundleExecutable</key><string>Sun Valley</string></dict></plist>\n";
        std::fs::write(bundle.join("Contents/Info.plist"), plist).unwrap();
        assert_eq!(bundle_executable(&bundle), Some(bundle.join("Contents/MacOS/Sun Valley")));
        std::fs::write(bundle.join("Contents/Info.plist"), plist.replace("Sun Valley", "../../evil")).unwrap();
        assert_eq!(bundle_executable(&bundle), None);
    }

    #[test]
    fn times_out_hung_processes() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("hang");
        std::fs::write(&exe, "#!/bin/sh\nsleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = Instant::now();
        assert!(run_with_timeout(&exe, &[], Duration::from_millis(300)).unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn counts_unreal_folders_only_once_the_editor_exists() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("Epic Games");
        std::fs::create_dir_all(shared.join("UE_5.8/.egstore/Pending")).unwrap();
        let xcode = XcodeState::default();
        let partial = discover_unreal_at(None, &shared, &dir.path().join("Launcher.app"), &xcode, None);
        assert!(partial.installs.is_empty(), "a download in progress is not an install");
        assert!(partial.notes.iter().any(|n| n.contains("UE_5.8") && n.contains("not a finished install")));

        let editor = shared.join("UE_5.7/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS");
        std::fs::create_dir_all(&editor).unwrap();
        std::fs::write(editor.join("UnrealEditor"), "").unwrap();
        let dat = dir.path().join("LauncherInstalled.dat");
        std::fs::write(&dat, format!("{{\"InstallationList\":[{{\"AppName\":\"UE_5.7\",\"AppVersion\":\"5.7.4-123+++UE5+Release-5.7\",\"InstallLocation\":\"{}\"}}]}}", shared.join("UE_5.7").display())).unwrap();
        let found = discover_unreal_at(Some(&dat), &shared, &dir.path().join("Launcher.app"), &xcode, None);
        assert_eq!(found.installs.len(), 1, "listed by the launcher and in the shared folder, counted once");
        assert_eq!(found.installs[0].version, "5.7");
        assert_eq!(found.installs[0].full_version, "5.7.4-123+++UE5+Release-5.7");
        assert!(found.installs[0].executable.ends_with("UnrealEditor.app/Contents/MacOS/UnrealEditor"));
    }

    #[test]
    fn reports_whether_the_realistic_template_has_its_sample() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("Epic Games");
        let xcode = XcodeState { app: None, version: None, selected: None, metal: false };
        let status = |sample: Option<PathBuf>| {
            let r = discover_unreal_at(None, &shared, &dir.path().join("Launcher.app"), &xcode, sample);
            r.capabilities.into_iter().find(|c| c.id == "animation-sample").unwrap()
        };
        let missing = status(None);
        assert_eq!(missing.status, "unavailable");
        assert!(missing.reason.unwrap().contains("fab.com"));
        let found = status(Some(dir.path().join("GameAnimationSample")));
        assert_eq!(found.status, "available");
        assert!(found.reason.unwrap().contains("GameAnimationSample"));
    }

    #[test]
    fn explains_what_unreal_needs_from_xcode() {
        let problems = |x: &XcodeState| xcode_tools(x).into_iter().map(|t| (t.name, t.found, t.problem.unwrap_or_default())).collect::<Vec<_>>();
        let none = problems(&XcodeState::default());
        assert!(!none[0].1 && none[0].2.contains("needs Xcode"));
        assert!(!none[1].1 && none[1].2.contains(GET_METAL));
        let clt = XcodeState { app: Some(PathBuf::from(XCODE_APP)), version: Some("27.2".into()), selected: Some("/Library/Developer/CommandLineTools".into()), metal: false };
        let p = problems(&clt);
        assert!(p[0].1 && p[0].2.contains("Xcode Not Found") && p[0].2.contains(SELECT_XCODE));
        let ready = XcodeState { selected: Some("/Applications/Xcode.app/Contents/Developer".into()), metal: true, ..clt };
        assert!(problems(&ready).iter().all(|(_, found, problem)| *found && problem.is_empty()));
    }

    /// Opt-in check against this machine: cargo test real_unreal_folders -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_unreal_folders_are_reported_honestly() {
        let report = discover_unreal();
        println!("installs: {:?}", report.installs.iter().map(|i| (&i.version, &i.executable)).collect::<Vec<_>>());
        println!("notes: {:?}", report.notes);
        println!("tools: {:?}", report.tools.iter().map(|t| (&t.name, t.found, &t.problem)).collect::<Vec<_>>());
        for i in &report.installs {
            assert!(Path::new(&i.executable).is_file(), "{}", i.executable);
        }
    }

    #[test]
    fn unreal_and_unity_projects_run_studio_rules() {
        assert_eq!(discover_unreal().capabilities.iter().find(|c| c.id == "rules").unwrap().status, "available");
        assert_eq!(discover_unity().capabilities.iter().find(|c| c.id == "rules").unwrap().status, "available");
    }

    #[test]
    fn unreal_builds_wait_for_xcode_and_its_metal_toolchain() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("Epic Games");
        let editor = shared.join("UE_5.8/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS");
        std::fs::create_dir_all(&editor).unwrap();
        std::fs::write(editor.join("UnrealEditor"), "").unwrap();
        let status = |x: &XcodeState| {
            let r = discover_unreal_at(None, &shared, &dir.path().join("Launcher.app"), x, None);
            let c = r.capabilities.into_iter().find(|c| c.id == "build").unwrap();
            (c.status, c.reason.unwrap_or_default())
        };
        let clt = XcodeState { app: Some(PathBuf::from(XCODE_APP)), version: None, selected: Some("/Library/Developer/CommandLineTools".into()), metal: true };
        assert!(status(&clt).1.contains("xcode-select"));
        let no_metal = XcodeState { selected: Some("/Applications/Xcode.app/Contents/Developer".into()), metal: false, ..clt.clone() };
        assert!(status(&no_metal).1.contains("MetalToolchain"));
        let ready = XcodeState { metal: true, ..no_metal };
        assert_eq!(status(&ready), ("available".to_string(), String::new()));
        let found = discover_unreal_at(None, &shared, &dir.path().join("Launcher.app"), &ready, None);
        assert!(found.installs[0].compatible && found.installs[0].note.is_none());
    }

    #[test]
    fn discovers_unity_editors_modules_and_licences() {
        let dir = tempfile::tempdir().unwrap();
        let editors = dir.path().join("Editor");
        let status = |r: &EngineReport, id: &str| r.capabilities.iter().find(|c| c.id == id).unwrap().status.clone();
        let empty = discover_unity_at(&[editors.clone()], &dir.path().join("Hub.app"), &[]);
        assert!(empty.installs.is_empty());
        assert_eq!(status(&empty, "projects"), "available");
        assert_eq!(status(&empty, "open-editor"), "unavailable");
        assert_eq!(status(&empty, "build"), "unavailable");

        let fake = |version: &str, mac: bool| {
            let folder = editors.join(version);
            std::fs::create_dir_all(folder.join("Unity.app/Contents/MacOS")).unwrap();
            std::fs::write(folder.join("Unity.app/Contents/MacOS/Unity"), "").unwrap();
            if mac {
                std::fs::create_dir_all(folder.join("PlaybackEngines/MacStandaloneSupport")).unwrap();
            }
        };
        fake("2022.3.45f1", true);
        fake("6000.6.9f1", false);
        std::fs::create_dir_all(editors.join("not-a-version/Unity.app/Contents/MacOS")).unwrap();
        let licence = dir.path().join("UnityEntitlementLicense.xml");
        let no_module = discover_unity_at(&[editors.clone()], &dir.path().join("Hub.app"), &[licence.clone()]);
        assert_eq!(no_module.installs.iter().map(|i| (i.version.as_str(), i.compatible)).collect::<Vec<_>>(), vec![("2022.3.45f1", false), ("6000.6.9f1", true)]);
        assert_eq!(status(&no_module, "open-editor"), "available");
        assert!(no_module.capabilities.iter().find(|c| c.id == "build").unwrap().reason.as_deref().unwrap().contains("Mac Build Support"));

        std::fs::create_dir_all(editors.join("6000.6.9f1/PlaybackEngines/MacStandaloneSupport")).unwrap();
        let no_licence = discover_unity_at(&[editors.clone()], &dir.path().join("Hub.app"), &[licence.clone()]);
        assert!(no_licence.capabilities.iter().find(|c| c.id == "build").unwrap().reason.as_deref().unwrap().contains("licence"));
        std::fs::write(&licence, "<xml/>").unwrap();
        let ready = discover_unity_at(&[editors], &dir.path().join("Hub.app"), &[licence]);
        assert_eq!(status(&ready, "build"), "available");
        assert!(ready.installs.iter().find(|i| i.version == "6000.6.9f1").unwrap().note.is_none());
        assert!(ready.tools.iter().find(|t| t.name == "Unity licence").unwrap().found);
    }

    #[test]
    fn accepts_only_unity_version_folder_names() {
        for ok in ["6000.6.9f1", "2022.3.45f1", "6000.1.0a12", "6000.2.0b3", "6000.0.23p1"] {
            assert!(unity_version_ok(ok), "{ok}");
        }
        for bad in ["6000.6.9", "Unity 6", "6000.6.9f", "60.6.9f1", "../6000.6.9f1", "6000.6.9x1"] {
            assert!(!unity_version_ok(bad), "{bad}");
        }
    }
}
