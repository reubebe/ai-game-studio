pub mod ai;
pub mod ai_stream;
pub mod builds;
pub mod db;
pub mod engines;
pub mod error;
pub mod installer;
pub mod library;
pub mod native;
pub mod paths;
pub mod play;
pub mod play_saves;
pub mod pointer_lock;
pub mod projects;
pub mod runner;
pub mod snapshots;
pub mod timeutil;
pub mod unreal_sample;

use db::{AuditEntry, Db, RecentProject};
use error::{AppError, AppResult};
use projects::{FileEntry, ImportedFile, NewFile};
use runner::{RunStep, Runs};
use serde::Serialize;
use serde_json::Value;
use snapshots::{Snapshot, SnapshotStatus};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub struct AppState {
    pub data_dir: PathBuf,
    pub db: Mutex<Db>,
    /// Project folders opened or created in this session; every file command must name one.
    pub roots: Mutex<HashSet<PathBuf>>,
    /// Paths the user chose in a native dialog or dropped on the window.
    pub granted: Mutex<HashSet<PathBuf>>,
    pub runs: Arc<Runs>,
    pub ai_http: reqwest::Client,
    pub dl_http: reqwest::Client,
    pub smoke_dir: Option<PathBuf>,
    /// Opt-in self-test checks (--smoke-extras); empty outside --smoke-test mode.
    pub smoke_extras: Vec<String>,
    pub installing: tokio::sync::Mutex<()>,
    /// Chat replies being streamed, by stream id, with the sender that stops each one.
    pub streams: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    /// Web builds the Play view is showing (Play here), served on the gsplay: scheme.
    pub play: Arc<play::Sites>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
    platform: String,
    arch: String,
    git_available: bool,
    dev_build: bool,
    smoke_dir: Option<String>,
    smoke_extras: Vec<String>,
    default_projects_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    root: String,
    manifest: String,
    files: Vec<FileEntry>,
    snapshots: SnapshotStatus,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Internal(e.to_string()))?
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn default_projects_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp")).join("Documents/Game Studio Projects")
}

fn is_granted(state: &AppState, path: &Path) -> bool {
    let granted = lock(&state.granted);
    path.ancestors().any(|a| granted.contains(a))
}

fn may_use_folder(state: &AppState, path: &Path) -> bool {
    is_granted(state, path)
        || path.starts_with(default_projects_dir())
        || state.smoke_dir.as_ref().map(|d| path.starts_with(d)).unwrap_or(false)
        || lock(&state.db).is_recent(&path.to_string_lossy()).unwrap_or(false)
}

fn ensure_root(state: &AppState, root: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(root);
    if lock(&state.roots).contains(&p) {
        Ok(p)
    } else {
        Err(AppError::Denied("That project is not open in this session".into()))
    }
}

fn register_root(app: &AppHandle, state: &AppState, root: &Path, manifest: &Value) -> AppResult<()> {
    lock(&state.roots).insert(root.to_path_buf());
    // Image previews: only the project's asset folders are readable through the asset protocol.
    for dir in ["assets", "godot/assets"] {
        let _ = app.asset_protocol_scope().allow_directory(root.join(dir), true);
    }
    let str_field = |k: &str| manifest.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let template = manifest.pointer("/template/id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let engine = manifest.pointer("/engine/id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    lock(&state.db).touch_recent(&root.to_string_lossy(), &str_field("title"), &template, &engine)?;
    Ok(())
}

async fn open_project_at(app: &AppHandle, state: &AppState, root: PathBuf) -> AppResult<OpenedProject> {
    let r = root.clone();
    let (text, manifest, files, snaps) = blocking(move || {
        let (text, manifest) = projects::read_manifest(&r)?;
        let files = projects::list_files(&r)?;
        let snaps = snapshots::status(&r)?;
        Ok((text, manifest, files, snaps))
    })
    .await?;
    register_root(app, state, &root, &manifest)?;
    Ok(OpenedProject { root: root.to_string_lossy().to_string(), manifest: text, files, snapshots: snaps })
}

// ---- App, settings and dialogs ------------------------------------------------------------

#[tauri::command]
async fn app_info(state: State<'_, AppState>) -> AppResult<AppInfo> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: state.data_dir.to_string_lossy().into(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        git_available: blocking(|| Ok(snapshots::git_available())).await?,
        dev_build: cfg!(debug_assertions),
        smoke_dir: state.smoke_dir.as_ref().map(|d| d.to_string_lossy().to_string()),
        smoke_extras: state.smoke_extras.clone(),
        // The self-test's dialogs create projects in its own folder, never among the user's projects.
        default_projects_dir: state.smoke_dir.as_ref().map(|d| d.to_string_lossy().to_string()).unwrap_or_else(|| default_projects_dir().to_string_lossy().to_string()),
    })
}

#[tauri::command]
async fn settings_get(state: State<'_, AppState>) -> AppResult<serde_json::Map<String, Value>> {
    lock(&state.db).settings()
}

#[tauri::command]
async fn settings_set(state: State<'_, AppState>, key: String, value: Value) -> AppResult<serde_json::Map<String, Value>> {
    if key == "engines.godot.path" {
        if let Some(p) = value.as_str() {
            if !is_granted(&state, Path::new(p)) {
                return Err(AppError::Denied("Choose the Godot application with the Locate button".into()));
            }
        }
    }
    let db = lock(&state.db);
    db.set_setting(&key, &value)?;
    // Board games in progress ("board.*", saved as they are played and when paused) are not setting changes.
    if !key.starts_with("board.") {
        db.audit(None, "user", "settings.change", &serde_json::json!({ "key": key }))?;
    }
    db.settings()
}

#[tauri::command]
async fn pick_directory(app: AppHandle, state: State<'_, AppState>, title: String) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let picked = rx.await.ok().flatten().and_then(|p| p.into_path().ok());
    if let Some(p) = &picked {
        lock(&state.granted).insert(p.clone());
    }
    Ok(picked.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_files(app: AppHandle, state: State<'_, AppState>, title: String, extensions: Vec<String>, multiple: bool) -> AppResult<Vec<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file().set_title(title);
    if !extensions.is_empty() {
        let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter("Supported files", &exts);
    }
    if multiple {
        builder.pick_files(move |p| {
            let _ = tx.send(p.unwrap_or_default());
        });
    } else {
        builder.pick_file(move |p| {
            let _ = tx.send(p.into_iter().collect());
        });
    }
    let paths: Vec<PathBuf> = rx.await.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect();
    let mut granted = lock(&state.granted);
    for p in &paths {
        granted.insert(p.clone());
    }
    Ok(paths.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
}

const EXTERNAL_HOSTS: &[&str] = &[
    "godotengine.org", "docs.godotengine.org", "github.com", "unity.com", "docs.unity.com", "unrealengine.com", "www.unrealengine.com", "dev.epicgames.com",
    "store.epicgames.com", "www.fab.com", "www.epicgames.com", "sfml-dev.org", "www.sfml-dev.org", "brew.sh", "ollama.com", "docs.ollama.com", "lmstudio.ai",
    "platform.claude.com", "platform.openai.com", "ai.google.dev", "en.wikipedia.org", "auale.joansala.com", "www.khronos.org",
];

#[tauri::command]
async fn open_external(url: String) -> AppResult<()> {
    let host = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://auale.joansala.com").map(|_| "auale.joansala.com/")).and_then(|r| r.split(['/', '?', '#']).next()).unwrap_or("");
    if !EXTERNAL_HOSTS.contains(&host) || url.contains(char::is_whitespace) {
        return Err(AppError::Denied(format!("Game Studio only opens known documentation and download sites ({host})")));
    }
    std::process::Command::new("/usr/bin/open").arg(&url).status()?;
    Ok(())
}

#[tauri::command]
async fn reveal_path(state: State<'_, AppState>, root: String, path: Option<String>) -> AppResult<()> {
    let root = ensure_root(&state, &root)?;
    let target = match path {
        Some(rel) => paths::resolve_in_root(&root, &rel)?,
        None => root,
    };
    std::process::Command::new("/usr/bin/open").arg("-R").arg(target).status()?;
    Ok(())
}

// ---- Projects -----------------------------------------------------------------------------

#[tauri::command]
async fn recents_list(state: State<'_, AppState>) -> AppResult<Vec<RecentProject>> {
    lock(&state.db).recents(30)
}

#[tauri::command]
async fn recents_forget(state: State<'_, AppState>, path: String) -> AppResult<()> {
    lock(&state.db).forget_recent(&path)
}

#[tauri::command]
async fn project_create(app: AppHandle, state: State<'_, AppState>, parent: String, folder: String, files: Vec<NewFile>, message: String) -> AppResult<OpenedProject> {
    let parent_path = PathBuf::from(&parent);
    if !parent_path.is_absolute() {
        return Err(AppError::Invalid("Choose a folder for the project".into()));
    }
    if parent_path == default_projects_dir() || parent_path.starts_with(default_projects_dir()) {
        std::fs::create_dir_all(&parent_path)?;
    }
    let parent_canon = paths::canonical_dir(&parent)?;
    if !may_use_folder(&state, &parent_canon) && !may_use_folder(&state, &parent_path) {
        return Err(AppError::Denied("Choose the location with the folder picker first".into()));
    }
    let root = blocking(move || {
        let root = projects::create_project(&parent_canon, &folder, &files)?;
        if snapshots::git_available() {
            snapshots::init(&root)?;
            snapshots::create(&root, &message)?;
        }
        Ok(root)
    })
    .await?;
    lock(&state.db).audit(Some(&root.to_string_lossy()), "user", "project.create", &serde_json::json!({}))?;
    open_project_at(&app, &state, root).await
}

#[tauri::command]
async fn project_open(app: AppHandle, state: State<'_, AppState>, path: String) -> AppResult<OpenedProject> {
    let root = paths::canonical_dir(&path)?;
    if !may_use_folder(&state, &root) {
        return Err(AppError::Denied("Choose the project folder with the Open button first".into()));
    }
    open_project_at(&app, &state, root).await
}

#[tauri::command]
async fn project_close(state: State<'_, AppState>, root: String) -> AppResult<()> {
    let root = PathBuf::from(root);
    state.play.close_under(&root);
    lock(&state.roots).remove(&root);
    Ok(())
}

#[tauri::command]
async fn project_files(state: State<'_, AppState>, root: String) -> AppResult<Vec<FileEntry>> {
    let root = ensure_root(&state, &root)?;
    blocking(move || projects::list_files(&root)).await
}

#[tauri::command]
async fn project_read(state: State<'_, AppState>, root: String, path: String) -> AppResult<String> {
    let root = ensure_root(&state, &root)?;
    blocking(move || projects::read_text(&root, &path)).await
}

#[tauri::command]
async fn project_write(state: State<'_, AppState>, root: String, files: Vec<NewFile>) -> AppResult<()> {
    let root = ensure_root(&state, &root)?;
    blocking(move || projects::write_texts(&root, &files)).await
}

#[tauri::command]
async fn project_trash(state: State<'_, AppState>, root: String, path: String) -> AppResult<String> {
    let root_path = ensure_root(&state, &root)?;
    let p = path.clone();
    let moved = blocking(move || projects::trash(&root_path, &p)).await?;
    lock(&state.db).audit(Some(&root), "user", "file.trash", &serde_json::json!({ "path": path, "movedTo": moved }))?;
    Ok(moved)
}

#[tauri::command]
async fn project_import(state: State<'_, AppState>, root: String, sources: Vec<String>, dest_dir: String) -> AppResult<Vec<ImportedFile>> {
    let root_path = ensure_root(&state, &root)?;
    let mut list = Vec::new();
    for s in &sources {
        let p = PathBuf::from(s);
        if !is_granted(&state, &p) {
            return Err(AppError::Denied("Only files you chose or dropped can be imported".into()));
        }
        list.push(p);
    }
    let imported = blocking(move || projects::import_files(&root_path, &list, &dest_dir)).await?;
    lock(&state.db).audit(Some(&root), "user", "assets.import", &serde_json::json!({ "count": imported.len() }))?;
    Ok(imported)
}

// ---- Free asset library and linked pages --------------------------------------------------

#[tauri::command]
async fn library_list(kind: String) -> AppResult<Vec<library::LibraryAsset>> {
    library::list_assets(&kind).await
}

#[tauri::command]
fn library_characters() -> Vec<library::CatalogCharacter> {
    library::CHARACTERS.to_vec()
}

#[tauri::command]
fn library_sounds() -> Vec<library::CatalogSound> {
    library::SOUNDS.to_vec()
}

#[tauri::command]
async fn library_thumbnail(id: String) -> AppResult<String> {
    library::thumbnail(&id).await
}

#[tauri::command]
async fn library_download(state: State<'_, AppState>, root: String, kind: String, id: String, resolution: String, dest_dir: String) -> AppResult<Vec<ImportedFile>> {
    let root_path = ensure_root(&state, &root)?;
    let files = match kind.as_str() {
        "characters" => {
            // Realistic people are converted with Godot after downloading.
            let godot = best_godot(&state).ok().map(|i| PathBuf::from(i.executable));
            library::download_character(&root_path, &dest_dir, &id, godot.as_deref()).await?
        }
        "sounds" => library::download_sound(&root_path, &dest_dir, &id).await?,
        _ => library::download(&root_path, &dest_dir, &kind, &id, &resolution).await?,
    };
    lock(&state.db).audit(Some(&root), "user", "assets.library", &serde_json::json!({ "source": "polyhaven", "id": id, "kind": kind, "resolution": resolution, "count": files.len() }))?;
    Ok(files)
}

#[tauri::command]
async fn page_fetch(url: String) -> AppResult<library::PageText> {
    library::fetch_page(&url).await
}

// ---- Epic's Game Animation Sample (realistic Unreal template) ------------------------------

/// The sample's settings, for generating a realistic Unreal project; refused when it is not on this Mac.
#[tauri::command]
async fn unreal_sample_files() -> AppResult<unreal_sample::SampleFiles> {
    blocking(|| {
        let sample = unreal_sample::find_sample().ok_or_else(|| AppError::NotFound(format!("Epic's Game Animation Sample is not in Documents/Unreal Projects. {}", unreal_sample::HOW_TO)))?;
        unreal_sample::read_sample(&sample)
    })
    .await
}

/// Copies the sample's content into an open project's Unreal folder (clones on APFS).
#[tauri::command]
async fn unreal_sample_add(state: State<'_, AppState>, root: String, engine_dir: String) -> AppResult<unreal_sample::SampleCopy> {
    let root_path = ensure_root(&state, &root)?;
    let copied = blocking(move || {
        let sample = unreal_sample::find_sample().ok_or_else(|| AppError::NotFound(format!("Epic's Game Animation Sample is not in Documents/Unreal Projects. {}", unreal_sample::HOW_TO)))?;
        unreal_sample::copy_sample(&sample, &root_path, &engine_dir)
    })
    .await?;
    lock(&state.db).audit(Some(&root), "user", "unreal.sample", &serde_json::json!({ "files": copied.files, "bytes": copied.bytes }))?;
    Ok(copied)
}

// ---- Snapshots ----------------------------------------------------------------------------

#[tauri::command]
async fn snapshot_status(state: State<'_, AppState>, root: String) -> AppResult<SnapshotStatus> {
    let root = ensure_root(&state, &root)?;
    blocking(move || snapshots::status(&root)).await
}

#[tauri::command]
async fn snapshot_list(state: State<'_, AppState>, root: String, limit: u32) -> AppResult<Vec<Snapshot>> {
    let root = ensure_root(&state, &root)?;
    blocking(move || snapshots::list(&root, limit)).await
}

#[tauri::command]
async fn snapshot_create(state: State<'_, AppState>, root: String, message: String) -> AppResult<Option<Snapshot>> {
    let root = ensure_root(&state, &root)?;
    blocking(move || snapshots::create(&root, &message)).await
}

#[tauri::command]
async fn snapshot_restore(state: State<'_, AppState>, root: String, id: String) -> AppResult<Snapshot> {
    let root_path = ensure_root(&state, &root)?;
    let i = id.clone();
    let snap = blocking(move || snapshots::restore(&root_path, &i)).await?;
    lock(&state.db).audit(Some(&root), "user", "snapshot.restore", &serde_json::json!({ "id": id }))?;
    Ok(snap)
}

// ---- Engines and runs ---------------------------------------------------------------------

fn configured_godot(state: &AppState) -> Option<String> {
    lock(&state.db).get_setting("engines.godot.path").ok().flatten().and_then(|v| v.as_str().map(String::from))
}

#[tauri::command]
async fn engines_discover(state: State<'_, AppState>) -> AppResult<Vec<engines::EngineReport>> {
    let data_dir = state.data_dir.clone();
    let configured = configured_godot(&state);
    blocking(move || {
        let templates = engines::godot_templates_root();
        Ok(vec![engines::discover_godot(&data_dir, configured.as_deref(), templates.as_deref()), engines::discover_unity(), engines::discover_unreal(), engines::discover_cpp()])
    })
    .await
}

#[tauri::command]
async fn engine_install_godot(app: AppHandle, state: State<'_, AppState>, version: String, approved: bool) -> AppResult<String> {
    if !approved {
        return Err(AppError::Denied("Installing Godot needs your approval".into()));
    }
    let _guard = state.installing.try_lock().map_err(|_| AppError::Conflict("An installation is already running".into()))?;
    let path = installer::install_godot(&app, &state.dl_http, &state.data_dir, &version).await?;
    lock(&state.db).audit(None, "user", "engine.install", &serde_json::json!({ "engine": "godot", "version": version, "path": path }))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn engine_install_godot_templates(app: AppHandle, state: State<'_, AppState>, version: String, approved: bool) -> AppResult<String> {
    if !approved {
        return Err(AppError::Denied("Installing export templates needs your approval".into()));
    }
    let root = engines::godot_templates_root().ok_or_else(|| AppError::Unavailable("Could not find your home folder".into()))?;
    let _guard = state.installing.try_lock().map_err(|_| AppError::Conflict("An installation is already running".into()))?;
    let path = installer::install_godot_templates(&app, &state.dl_http, &state.data_dir, &root, &version).await?;
    lock(&state.db).audit(None, "user", "engine.install", &serde_json::json!({ "engine": "godot-export-templates", "version": version, "path": path }))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn engine_open_tool(tool: String) -> AppResult<()> {
    let app = match tool.as_str() {
        "unity-hub" => "/Applications/Unity Hub.app",
        "epic-launcher" => "/Applications/Epic Games Launcher.app",
        _ => return Err(AppError::Invalid("Unknown tool".into())),
    };
    if !Path::new(app).is_dir() {
        return Err(AppError::NotFound(format!("{app} is not installed")));
    }
    std::process::Command::new("/usr/bin/open").arg("-a").arg(app).status()?;
    Ok(())
}

fn best_godot(state: &AppState) -> AppResult<engines::EngineInstall> {
    let report = engines::discover_godot(&state.data_dir, configured_godot(state).as_deref(), None);
    engines::preferred_install(&report.installs).cloned().ok_or_else(|| AppError::Unavailable("Godot is not installed. Open Engines to install or locate it.".into()))
}

/// What an Export button builds. Windows and Linux builds are 64-bit x86 programs with the game's
/// data in a .pck beside them (planGodotDesktopExport in packages/project/src/export.ts).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ExportTarget {
    Mac,
    Windows,
    Linux,
}

impl ExportTarget {
    fn from_action(action: &str) -> Option<Self> {
        match action {
            "export" => Some(Self::Mac),
            "export-windows" => Some(Self::Windows),
            "export-linux" => Some(Self::Linux),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Mac => "macOS",
            Self::Windows => "Windows",
            Self::Linux => "Linux",
        }
    }

    /// Godot's platform names for the target; Linux was "Linux/X11" before Godot 4.2.
    fn platforms(self) -> &'static [&'static str] {
        match self {
            Self::Mac => &["macOS"],
            Self::Windows => &["Windows Desktop"],
            Self::Linux => &["Linux", "Linux/X11"],
        }
    }
}

/// Export with the project's preset for `target` into the project folder, then run the exported
/// game's own self-test. A macOS app runs its self-test itself. A Windows or Linux program cannot
/// run on a Mac, so Godot here runs the exported game data (the .pck beside the program, or the
/// program itself when the pack is embedded in it) with the same self-test. Game Studio writes the
/// presets (after asking) from the Play view; see planGodotExport and planGodotDesktopExport in
/// packages/project/src/export.ts.
fn plan_godot_export(root: &Path, engine_dir: &str, work: &Path, install: &engines::EngineInstall, mut steps: Vec<RunStep>, target: ExportTarget) -> AppResult<Vec<RunStep>> {
    let label = target.label();
    let templates = engines::godot_templates_root().ok_or_else(|| AppError::Unavailable("Could not find your home folder".into()))?;
    let folder = engines::templates_folder(install);
    let ready = match target {
        ExportTarget::Mac => engines::templates_ready(&templates, &folder),
        ExportTarget::Windows => engines::template_file_ready(&templates, &folder, engines::WINDOWS_TEMPLATE),
        ExportTarget::Linux => engines::template_file_ready(&templates, &folder, engines::LINUX_TEMPLATE),
    };
    if !ready {
        return Err(AppError::Unavailable(format!("Exporting for {label} needs the Godot {folder} export templates. Install them in Engines.")));
    }
    let cfg = std::fs::read_to_string(work.join("export_presets.cfg")).map_err(|_| AppError::Unavailable(format!("This project has no export_presets.cfg yet. Use Export for {label} in the Play view and Game Studio will offer to add one.")))?;
    let preset = builds::parse_presets(&cfg)
        .into_iter()
        .find(|p| target.platforms().contains(&p.platform.as_str()))
        .ok_or_else(|| AppError::Unavailable(format!("export_presets.cfg has no {label} preset. Use Export for {label} in the Play view and Game Studio will offer to add one.")))?;
    let rel = match target {
        ExportTarget::Mac => builds::app_path_in_project(engine_dir, &preset.export_path)?,
        ExportTarget::Windows => builds::windows_exe_in_project(engine_dir, &preset.export_path)?,
        ExportTarget::Linux => builds::linux_program_in_project(engine_dir, &preset.export_path)?,
    };
    let build = paths::resolve_in_root(root, &rel)?;
    let out_dir = build.parent().ok_or_else(|| AppError::Invalid("Invalid export path".into()))?.to_path_buf();
    std::fs::create_dir_all(&out_dir)?;
    let godot = PathBuf::from(&install.executable);
    let args = vec!["--headless".to_string(), "--path".into(), work.to_string_lossy().to_string(), "--export-release".into(), preset.name.clone(), build.to_string_lossy().to_string()];
    steps.push(RunStep { label: format!("Export for {label}"), program: godot.clone(), args, cwd: work.to_path_buf() });
    if target == ExportTarget::Mac {
        steps.push(RunStep { label: "Check the exported build".into(), program: build, args: s(&["--headless", "--", "--studio-smoke"]), cwd: out_dir });
    } else {
        // Godot names the pack after the program without its last extension (Game.exe, Game.pck).
        let pack = if preset.embed_pck { build.clone() } else { build.with_extension("pck") };
        let args = vec!["--headless".to_string(), "--main-pack".into(), pack.to_string_lossy().to_string(), "--".into(), "--studio-smoke".into()];
        steps.push(RunStep { label: "Check the exported game data".into(), program: godot, args, cwd: out_dir });
    }
    Ok(steps)
}

/// Play here: build the game with the project's Web preset (the single-threaded template) into the
/// project folder. The Play view adds the preset first (after asking; see planGodotWebExport in
/// packages/project/src/export.ts) and then shows the build with play_web_open.
fn plan_godot_web(root: &Path, engine_dir: &str, work: &Path, install: &engines::EngineInstall, mut steps: Vec<RunStep>) -> AppResult<Vec<RunStep>> {
    let templates = engines::godot_templates_root().ok_or_else(|| AppError::Unavailable("Could not find your home folder".into()))?;
    let folder = engines::templates_folder(install);
    if !engines::web_templates_ready(&templates, &folder) {
        return Err(AppError::Unavailable(format!("Play here needs the Godot {folder} export templates, including {}. Install them in Engines.", engines::WEB_TEMPLATE)));
    }
    let web = web_preset_page(root, engine_dir, work)?;
    std::fs::create_dir_all(web.page.parent().ok_or_else(|| AppError::Invalid("Invalid export path".into()))?)?;
    let godot = PathBuf::from(&install.executable);
    let args = vec!["--headless".to_string(), "--path".into(), work.to_string_lossy().to_string(), "--export-debug".into(), web.preset, web.page.to_string_lossy().to_string()];
    steps.push(RunStep { label: "Build for the web".into(), program: godot, args, cwd: work.to_path_buf() });
    Ok(steps)
}

struct WebPage {
    preset: String,
    /// Relative to the project root, and absolute.
    rel: String,
    page: PathBuf,
}

fn web_preset_page(root: &Path, engine_dir: &str, work: &Path) -> AppResult<WebPage> {
    let cfg = std::fs::read_to_string(work.join("export_presets.cfg")).map_err(|_| AppError::Unavailable("This project has no export_presets.cfg yet. Use Play here in the Play view and Game Studio will offer to add a Web preset.".into()))?;
    let preset = builds::parse_presets(&cfg).into_iter().find(|p| p.platform == "Web").ok_or_else(|| AppError::Unavailable("export_presets.cfg has no Web preset. Use Play here in the Play view and Game Studio will offer to add one.".into()))?;
    let rel = builds::web_page_in_project(engine_dir, &preset.export_path)?;
    let page = paths::resolve_in_root(root, &rel)?;
    Ok(WebPage { preset: preset.name, rel, page })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayWeb {
    /// Address of Game Studio's page for the build, for the Play view's sandboxed frame.
    url: String,
    /// The build's page relative to the project root.
    page: String,
    /// Size of the engine and game data the frame downloads.
    bytes: u64,
}

/// Serves a project's web build to the Play view (Play here), under a fresh token.
#[tauri::command]
async fn play_web_open(state: State<'_, AppState>, root: String) -> AppResult<PlayWeb> {
    let root_path = ensure_root(&state, &root)?;
    let engine = manifest_engine(&root_path)?;
    if engine.id != "godot" {
        return Err(AppError::Unavailable("Only Godot projects play here".into()));
    }
    let dir = engine.dir.ok_or_else(|| AppError::Unavailable("This project has no engine folder".into()))?;
    let work = paths::resolve_in_root(&root_path, &dir)?;
    let web = web_preset_page(&root_path, &dir, &work)?;
    let folder = web.page.parent().ok_or_else(|| AppError::Invalid("Invalid export path".into()))?.to_path_buf();
    let stem = web
        .page
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| play::is_safe_stem(s))
        .ok_or_else(|| AppError::Invalid("The Web preset's page name may use only letters, digits, dots, dashes and underscores".into()))?
        .to_string();
    if let Some(missing) = play::missing_file(&folder, &stem) {
        return Err(AppError::NotFound(format!("The web build has no {missing} yet. Build it with Play here first.")));
    }
    let bytes = ["wasm", "pck"].iter().filter_map(|ext| std::fs::metadata(folder.join(format!("{stem}.{ext}"))).ok()).map(|m| m.len()).sum();
    let token = state.play.open(folder, stem);
    lock(&state.db).audit(Some(&root), "user", "play.web", &serde_json::json!({ "page": web.rel }))?;
    Ok(PlayWeb { url: play::site_url(&token), page: web.rel, bytes })
}

/// Play here keeps the game's user:// files (its saves) for it: the game's sandboxed frame has no
/// storage of its own. See play_saves.rs.
fn saves_file(state: &AppState, root: &str) -> AppResult<PathBuf> {
    let root_path = ensure_root(state, root)?;
    let engine = manifest_engine(&root_path)?;
    Ok(play_saves::file_for(&state.data_dir, &engine.project_id, &root_path))
}

#[tauri::command]
async fn play_saves_read(state: State<'_, AppState>, root: String) -> AppResult<Option<String>> {
    let file = saves_file(&state, &root)?;
    play_saves::read(&file).map_err(|e| AppError::Invalid(format!("This game's saves could not be read: {e}")))
}

#[tauri::command]
async fn play_saves_write(state: State<'_, AppState>, root: String, text: String) -> AppResult<usize> {
    let file = saves_file(&state, &root)?;
    play_saves::write(&file, &text).map_err(|e| AppError::Invalid(format!("The game's saves were not kept: {e}")))
}

#[tauri::command]
async fn play_saves_clear(state: State<'_, AppState>, root: String) -> AppResult<()> {
    let file = saves_file(&state, &root)?;
    play_saves::clear(&file).map_err(|e| AppError::Internal(format!("The saves could not be deleted: {e}")))?;
    lock(&state.db).audit(Some(&root), "user", "play.saves.clear", &serde_json::json!({}))?;
    Ok(())
}

struct ManifestEngine {
    id: String,
    dir: Option<String>,
    target: Option<String>,
    version: String,
    project_id: String,
}

fn manifest_engine(root: &Path) -> AppResult<ManifestEngine> {
    let (_, m) = projects::read_manifest(root)?;
    let text = |p: &str| m.pointer(p).and_then(|v| v.as_str()).map(String::from);
    Ok(ManifestEngine {
        id: text("/engine/id").unwrap_or_default(),
        dir: text("/engine/projectDir"),
        target: text("/engine/target"),
        version: text("/engine/version").unwrap_or_default(),
        project_id: text("/projectId").unwrap_or_else(|| "game".into()),
    })
}

/// Unity runs: open the editor, or build with StudioBuild.BuildMac (template script) and optionally
/// run the built app windowed or headless with its self-test.
fn plan_unity(root: &Path, work: &Path, engine: &ManifestEngine, action: &str, output: Option<&str>) -> AppResult<Vec<RunStep>> {
    let report = engines::discover_unity();
    let install = report.installs.iter().find(|i| i.version == engine.version).ok_or_else(|| {
        let found: Vec<&str> = report.installs.iter().map(|i| i.version.as_str()).collect();
        AppError::Unavailable(format!(
            "This project uses Unity {}{}. Install that version with Unity Hub.",
            engine.version,
            if found.is_empty() { String::new() } else { format!("; this computer has {}", found.join(", ")) }
        ))
    })?;
    let unity = PathBuf::from(&install.executable);
    let path = work.to_string_lossy().to_string();
    if action == "editor" {
        let args = s(&["-projectPath", &path, "-executeMethod", "GameStudio.EditorTools.StudioBuild.OpenMainScene", "-logFile", "-"]);
        return Ok(vec![RunStep { label: "Unity editor".into(), program: unity, args, cwd: work.to_path_buf() }]);
    }
    if !["build", "play", "smoke"].contains(&action) {
        return Err(AppError::Invalid(format!("Unity projects cannot '{action}'")));
    }
    let build_cap = report.capabilities.iter().find(|c| c.id == "build");
    if build_cap.map(|c| c.status != "available").unwrap_or(true) {
        return Err(AppError::Unavailable(build_cap.and_then(|c| c.reason.clone()).unwrap_or_else(|| "Unity cannot build on this computer yet".into())));
    }
    let name = builds::app_file_name(output, &engine.project_id);
    let app_path = paths::resolve_in_root(root, &format!("exports/unity-macos/{name}"))?;
    let out_dir = app_path.parent().ok_or_else(|| AppError::Invalid("Invalid build path".into()))?.to_path_buf();
    std::fs::create_dir_all(&out_dir)?;
    let product = name.trim_end_matches(".app").to_string();
    let app_arg = app_path.to_string_lossy().to_string();
    let bundle = builds::bundle_id(&engine.project_id);
    let build_args = s(&[
        "-batchmode", "-nographics", "-quit", "-projectPath", &path, "-executeMethod", "GameStudio.EditorTools.StudioBuild.BuildMac",
        "-studioOutput", &app_arg, "-studioProduct", &product, "-studioBundleId", &bundle, "-logFile", "-",
    ]);
    let mut steps = vec![RunStep { label: "Build for macOS".into(), program: unity, args: build_args, cwd: work.to_path_buf() }];
    match action {
        "play" => steps.push(RunStep { label: "Run game".into(), program: app_path, args: s(&["-logFile", "-", "--studio-telemetry"]), cwd: out_dir }),
        "smoke" => steps.push(RunStep { label: "Headless self-test".into(), program: app_path, args: s(&["-batchmode", "-nographics", "-logFile", "-", "--studio-smoke"]), cwd: out_dir }),
        _ => {}
    }
    Ok(steps)
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Unreal runs: compile the project's C++ module with UnrealBuildTool, then open the editor, or
/// package with BuildCookRun into exports/unreal-macos and optionally run the packaged app.
fn plan_unreal(root: &Path, work: &Path, engine: &ManifestEngine, action: &str) -> AppResult<Vec<RunStep>> {
    let report = engines::discover_unreal();
    let install = report.installs.iter().find(|i| i.version == engine.version).ok_or_else(|| {
        let found: Vec<&str> = report.installs.iter().map(|i| i.version.as_str()).collect();
        AppError::Unavailable(format!(
            "This project uses Unreal Engine {}{}. Install it from the Epic Games Launcher.",
            engine.version,
            if found.is_empty() { String::new() } else { format!("; this computer has {}", found.join(", ")) }
        ))
    })?;
    let needed = if action == "editor" { "open-editor" } else { "build" };
    if let Some(c) = report.capabilities.iter().find(|c| c.id == needed && c.status != "available") {
        return Err(AppError::Unavailable(c.reason.clone().unwrap_or_else(|| "Unreal cannot run here yet".into())));
    }
    let editor = PathBuf::from(&install.executable);
    let engine_root = editor.ancestors().find(|p| p.file_name().map(|n| n == "Engine").unwrap_or(false)).and_then(|p| p.parent()).ok_or_else(|| AppError::Internal("Unexpected Unreal Engine layout".into()))?.to_path_buf();
    let uproject = std::fs::read_dir(work)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().map(|x| x == "uproject").unwrap_or(false))
        .ok_or_else(|| AppError::NotFound("The Unreal folder has no .uproject file".into()))?;
    let name = uproject.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(AppError::Invalid("The .uproject name must be letters, digits or underscores".into()));
    }
    let project_arg = format!("-project={}", uproject.to_string_lossy());
    let compile = RunStep {
        label: "Compile C++ module".into(),
        program: engine_root.join("Engine/Build/BatchFiles/Mac/Build.sh"),
        args: vec![format!("{name}Editor"), "Mac".into(), "Development".into(), project_arg.clone(), "-waitmutex".into()],
        cwd: work.to_path_buf(),
    };
    if action == "editor" {
        return Ok(vec![compile, RunStep { label: "Unreal editor".into(), program: editor, args: vec![uproject.to_string_lossy().to_string()], cwd: work.to_path_buf() }]);
    }
    if !["build", "play", "smoke"].contains(&action) {
        return Err(AppError::Invalid(format!("Unreal projects cannot '{action}'")));
    }
    let out = paths::resolve_in_root(root, "exports/unreal-macos")?;
    std::fs::create_dir_all(&out)?;
    let package = RunStep {
        label: "Package for macOS".into(),
        program: engine_root.join("Engine/Build/BatchFiles/RunUAT.sh"),
        args: vec![
            "BuildCookRun".into(), project_arg, "-noP4".into(), "-platform=Mac".into(), "-clientconfig=Development".into(), "-build".into(), "-cook".into(),
            // -package copies the staged content into the .app; without it the app has no data and crashes at start.
            "-stage".into(), "-pak".into(), "-package".into(), "-archive".into(), format!("-archivedirectory={}", out.to_string_lossy()), "-unattended".into(), "-utf8output".into(),
        ],
        cwd: work.to_path_buf(),
    };
    let app = out.join("Mac").join(format!("{name}.app"));
    let mut steps = vec![compile, package];
    match action {
        // -LLM keeps Unreal's memory tracker on. Without it, Unreal 5.8 switches the tracker off on the game
        // thread while macOS may still be allocating inside a tracker scope on the main thread, and the game
        // aborts in FLLMTracker::PopTag (1 in 30 first launches here). Costs about 25 MB.
        "play" => steps.push(RunStep { label: "Run game".into(), program: app, args: s(&["-windowed", "-resx=1280", "-resy=720", "-LLM", "-studio-telemetry"]), cwd: out }),
        "smoke" => steps.push(RunStep { label: "Headless self-test".into(), program: app, args: s(&["-nullrhi", "-unattended", "-nosound", "-studio-smoke", "-LLM"]), cwd: out }),
        _ => {}
    }
    Ok(steps)
}

fn plan_run(state: &AppState, root: &Path, action: &str, output: Option<&str>) -> AppResult<Vec<RunStep>> {
    let engine = manifest_engine(root)?;
    let dir = engine.dir.clone().ok_or_else(|| AppError::Unavailable("This project has no engine folder to run".into()))?;
    let work = paths::resolve_in_root(root, &dir)?;
    let target = engine.target.clone();
    match engine.id.as_str() {
        "unity" => plan_unity(root, &work, &engine, action, output),
        "unreal" => plan_unreal(root, &work, &engine, action),
        "godot" => {
            let install = best_godot(state)?;
            let godot = PathBuf::from(&install.executable);
            let path = work.to_string_lossy().to_string();
            let step = |label: &str, args: Vec<String>| RunStep { label: label.into(), program: godot.clone(), args, cwd: work.clone() };
            let mut steps = Vec::new();
            if (!work.join(".godot").is_dir() || builds::godot_needs_import(&work)) && action != "editor" {
                steps.push(step("Import assets", s(&["--headless", "--path", &path, "--import"])));
            }
            if let Some(target) = ExportTarget::from_action(action) {
                return plan_godot_export(root, &dir, &work, &install, steps, target);
            }
            if action == "web" {
                return plan_godot_web(root, &dir, &work, &install, steps);
            }
            steps.push(match action {
                "play" => step("Run game", s(&["--path", &path, "--", "--studio-telemetry"])),
                "editor" => step("Godot editor", s(&["--editor", "--path", &path])),
                "smoke" => step("Headless self-test", s(&["--headless", "--path", &path, "--", "--studio-smoke"])),
                "conformance" => step("Rules runtime conformance", s(&["--headless", "--path", &path, "--script", "res://addons/gamestudio_runtime/tests/run_conformance.gd"])),
                "xr" => step("XR scene", s(&["--path", &path, "res://scenes/xr_main.tscn"])),
                _ => return Err(AppError::Invalid(format!("Godot projects cannot '{action}'"))),
            });
            Ok(steps)
        }
        "cpp-sfml" => {
            let (cmake, _, _) = engines::working_cmake();
            let cmake = cmake.ok_or_else(|| AppError::Unavailable("No working CMake found. Install it with: brew install cmake".into()))?;
            let ctest = cmake.with_file_name("ctest");
            let target = target.unwrap_or_else(|| "game".into());
            if !target.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(AppError::Invalid("Invalid build target name".into()));
            }
            let build = work.join("build");
            let mut configure = s(&["-S", &work.to_string_lossy(), "-B", &build.to_string_lossy(), "-DCMAKE_BUILD_TYPE=Debug"]);
            if Path::new("/opt/homebrew").is_dir() {
                configure.push("-DCMAKE_PREFIX_PATH=/opt/homebrew".into());
            }
            let mut steps = vec![
                RunStep { label: "Configure".into(), program: cmake.clone(), args: configure, cwd: work.clone() },
                RunStep { label: "Build".into(), program: cmake.clone(), args: s(&["--build", &build.to_string_lossy(), "-j", "8"]), cwd: work.clone() },
            ];
            let exe = build.join(&target);
            match action {
                "build" => {}
                "play" => steps.push(RunStep { label: "Run game".into(), program: exe, args: vec![], cwd: work.clone() }),
                "smoke" => steps.push(RunStep { label: "Headless self-test".into(), program: exe, args: s(&["--smoke"]), cwd: work.clone() }),
                "test" => steps.push(RunStep { label: "Unit tests".into(), program: ctest, args: s(&["--test-dir", &build.to_string_lossy(), "--output-on-failure"]), cwd: work.clone() }),
                _ => return Err(AppError::Invalid(format!("C++ projects cannot '{action}'"))),
            }
            Ok(steps)
        }
        other => Err(AppError::Unavailable(format!("'{other}' projects play inside Game Studio and have no external run"))),
    }
}

#[tauri::command]
async fn run_start(app: AppHandle, state: State<'_, AppState>, root: String, action: String, output: Option<String>) -> AppResult<String> {
    let root_path = ensure_root(&state, &root)?;
    let steps = plan_run(&state, &root_path, &action, output.as_deref())?;
    lock(&state.db).audit(Some(&root), "user", "run.start", &serde_json::json!({ "action": action }))?;
    Ok(state.runs.start(app, steps).await)
}

#[tauri::command]
async fn run_stop(state: State<'_, AppState>, run_id: String) -> AppResult<bool> {
    Ok(state.runs.stop(&run_id).await)
}

// ---- AI and audit -------------------------------------------------------------------------

fn cloud_allowed(state: &AppState) -> bool {
    lock(&state.db).get_setting("ai.allowCloud").ok().flatten().and_then(|v| v.as_bool()).unwrap_or(false)
}

#[tauri::command]
async fn ai_providers(state: State<'_, AppState>) -> AppResult<Vec<ai::ProviderStatus>> {
    Ok(ai::statuses(&state.ai_http, cloud_allowed(&state)).await)
}

#[tauri::command]
async fn ai_generate(state: State<'_, AppState>, request: ai::GenerateRequest, project: Option<String>) -> AppResult<ai::GenerateResult> {
    let outcome = ai::generate(&state.ai_http, &request, cloud_allowed(&state)).await;
    let detail = match &outcome {
        Ok(r) => serde_json::json!({ "provider": r.provider, "model": r.model, "ok": true, "durationMs": r.duration_ms, "inputTokens": r.input_tokens, "outputTokens": r.output_tokens }),
        Err(e) => serde_json::json!({ "provider": request.provider, "model": request.model, "ok": false, "error": e.code() }),
    };
    lock(&state.db).audit(project.as_deref(), "assistant", "ai.generate", &detail)?;
    outcome
}

/// One event of a streamed reply: a piece of text, "restart" (the provider broke the answer off and is
/// being asked again, so the text so far no longer counts), the finished result, or why it ended early.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEvent {
    stream_id: String,
    kind: &'static str,
    text: Option<String>,
    result: Option<ai::GenerateResult>,
    message: Option<String>,
}

/// Starts streaming a reply. The webview chooses the id and listens for "ai-stream" events before
/// calling, so no piece of text can arrive before it is listening.
#[tauri::command]
async fn ai_stream_start(app: AppHandle, state: State<'_, AppState>, stream_id: String, request: ai::GenerateRequest, project: Option<String>) -> AppResult<()> {
    if stream_id.len() != 36 || !stream_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(AppError::Invalid("Invalid stream id".into()));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut streams = lock(&state.streams);
        if streams.contains_key(&stream_id) {
            return Err(AppError::Conflict("That stream is already running".into()));
        }
        streams.insert(stream_id.clone(), tx);
    }
    let client = state.ai_http.clone();
    let allow_cloud = cloud_allowed(&state);
    tauri::async_runtime::spawn(async move {
        let emitter = app.clone();
        let id = stream_id.clone();
        let on_text = move |text: &str| {
            let _ = emitter.emit("ai-stream", StreamEvent { stream_id: id.clone(), kind: "delta", text: Some(text.to_string()), result: None, message: None });
        };
        let (restarter, restart_id) = (app.clone(), stream_id.clone());
        let on_restart = move || {
            let _ = restarter.emit("ai-stream", StreamEvent { stream_id: restart_id.clone(), kind: "restart", text: None, result: None, message: None });
        };
        let outcome = ai_stream::stream(&client, &request, allow_cloud, &on_text, &on_restart, rx).await;
        let state = app.state::<AppState>();
        lock(&state.streams).remove(&stream_id);
        let detail = match &outcome {
            Ok(r) => serde_json::json!({ "provider": r.provider, "model": r.model, "ok": true, "durationMs": r.duration_ms, "inputTokens": r.input_tokens, "outputTokens": r.output_tokens }),
            Err(e) => serde_json::json!({ "provider": request.provider, "model": request.model, "ok": false, "error": e.code() }),
        };
        let _ = lock(&state.db).audit(project.as_deref(), "assistant", "ai.stream", &detail);
        let event = match outcome {
            Ok(r) => StreamEvent { stream_id, kind: "done", text: None, result: Some(r), message: None },
            Err(e) => StreamEvent { stream_id, kind: "error", text: None, result: None, message: Some(e.to_string()) },
        };
        let _ = app.emit("ai-stream", event);
    });
    Ok(())
}

#[tauri::command]
fn ai_stream_stop(state: State<'_, AppState>, stream_id: String) -> bool {
    lock(&state.streams).remove(&stream_id).map(|tx| tx.send(()).is_ok()).unwrap_or(false)
}

#[tauri::command]
async fn audit_append(state: State<'_, AppState>, project: Option<String>, actor: String, action: String, detail: Value) -> AppResult<i64> {
    if !["user", "assistant", "studio"].contains(&actor.as_str()) || action.len() > 80 {
        return Err(AppError::Invalid("Invalid audit entry".into()));
    }
    lock(&state.db).audit(project.as_deref(), &actor, &action, &detail)
}

#[tauri::command]
async fn audit_list(state: State<'_, AppState>, project: Option<String>, limit: u32) -> AppResult<Vec<AuditEntry>> {
    lock(&state.db).audit_list(project.as_deref(), limit.min(1000))
}

// ---- Smoke-test mode ----------------------------------------------------------------------

#[tauri::command]
async fn smoke_finish(app: AppHandle, state: State<'_, AppState>, report: Value) -> AppResult<()> {
    let dir = state.smoke_dir.clone().ok_or_else(|| AppError::Denied("Not in smoke-test mode".into()))?;
    let pass = report.get("pass").and_then(|p| p.as_bool()).unwrap_or(false);
    projects::atomic_write(&dir.join("smoke-report.json"), serde_json::to_string_pretty(&report)?.as_bytes())?;
    app.exit(if pass { 0 } else { 1 });
    Ok(())
}

/// Self-test only: sends native mouse, scroll, pinch and key events to this window's web view.
#[tauri::command]
async fn smoke_input(window: tauri::WebviewWindow, state: State<'_, AppState>, steps: Vec<native::InputStep>) -> AppResult<Vec<String>> {
    if state.smoke_dir.is_none() {
        return Err(AppError::Denied("Not in smoke-test mode".into()));
    }
    if steps.len() > 400 {
        return Err(AppError::Invalid("Too many input steps".into()));
    }
    native::send_steps(&window, steps).await
}

/// Self-test only: saves a PNG of this window's web view as <smoke folder>/<name>.png.
#[tauri::command]
async fn smoke_snapshot(window: tauri::WebviewWindow, state: State<'_, AppState>, name: String) -> AppResult<String> {
    let dir = state.smoke_dir.clone().ok_or_else(|| AppError::Denied("Not in smoke-test mode".into()))?;
    if name.is_empty() || name.len() > 40 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::Invalid("Invalid snapshot name".into()));
    }
    let png = native::snapshot(&window).await?;
    let path = dir.join(format!("{name}.png"));
    projects::atomic_write(&path, &png)?;
    Ok(path.to_string_lossy().to_string())
}

/// Seconds since a person last touched the mouse, trackpad or keyboard: the self-test waits for a still
/// moment before driving the window, because a person's real pointer reaches the focused window too.
#[tauri::command]
fn smoke_idle(state: State<'_, AppState>) -> AppResult<f64> {
    state.smoke_dir.as_ref().ok_or_else(|| AppError::Denied("Not in smoke-test mode".into()))?;
    Ok(native::seconds_since_person_input())
}

/// Self-test only: the windows on screen (owner app, process, layer, size), so the opt-in editor
/// checks can see that the Unity or Unreal editor the Play view opened shows a window.
#[tauri::command]
fn smoke_windows(state: State<'_, AppState>) -> AppResult<Vec<native::ScreenWindow>> {
    state.smoke_dir.as_ref().ok_or_else(|| AppError::Denied("Not in smoke-test mode".into()))?;
    Ok(native::windows_on_screen())
}

/// A window picture saved by smoke_snapshot, as PNG bytes (the self-test reads colours from it).
#[tauri::command]
async fn smoke_picture(state: State<'_, AppState>, name: String) -> AppResult<tauri::ipc::Response> {
    let dir = state.smoke_dir.clone().ok_or_else(|| AppError::Denied("Not in smoke-test mode".into()))?;
    if name.is_empty() || name.len() > 40 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::Invalid("Invalid snapshot name".into()));
    }
    Ok(tauri::ipc::Response::new(std::fs::read(dir.join(format!("{name}.png")))?))
}

fn smoke_dir_from_args() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--smoke-test")?;
    let dir = PathBuf::from(args.get(i + 1)?);
    std::fs::create_dir_all(&dir).ok()?;
    dir.canonicalize().ok()
}

/// Opt-in self-test checks, comma separated after --smoke-extras: `editors` opens the Unity and Unreal
/// editors from the Play view's buttons (visible windows, minutes each), and `templates` installs the
/// Godot export templates from the Engines view when they are missing (a 1.3 GB download).
fn smoke_extras_from_args() -> Vec<String> {
    let args: Vec<String> = std::env::args().collect();
    let Some(i) = args.iter().position(|a| a == "--smoke-extras") else { return Vec::new() };
    args.get(i + 1).map(|list| list.split(',').map(|x| x.trim().to_string()).filter(|x| ["editors", "templates"].contains(&x.as_str())).collect()).unwrap_or_default()
}

pub fn run() {
    let smoke_dir = smoke_dir_from_args();
    let smoke_extras = if smoke_dir.is_some() { smoke_extras_from_args() } else { Vec::new() };
    // The self-test needs its window visible. Its input goes to the web view, not through the HID system, so
    // macOS counts the Mac as idle; the screen saver and lock then hide the window, and WebKit suspends a hidden
    // page after 240 s, which pauses the test (seen in a run with the editor checks). Keep the display awake for
    // as long as this process runs; caffeinate exits with it.
    #[cfg(target_os = "macos")]
    if smoke_dir.is_some() {
        let _ = std::process::Command::new("/usr/bin/caffeinate")
            .args(["-d", "-i", "-w", &std::process::id().to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let data_dir = match std::env::var_os("GAME_STUDIO_DATA_DIR").map(PathBuf::from) {
                Some(d) if d.is_absolute() => d,
                _ => match &smoke_dir {
                    Some(s) => s.join("app-data"),
                    None => app.path().app_data_dir()?,
                },
            };
            std::fs::create_dir_all(&data_dir)?;
            let db = Db::open(&data_dir.join("studio.db"))?;
            let mut granted = HashSet::new();
            if let Some(s) = &smoke_dir {
                granted.insert(s.clone());
            }
            app.manage(AppState {
                data_dir,
                db: Mutex::new(db),
                roots: Mutex::new(HashSet::new()),
                granted: Mutex::new(granted),
                runs: Arc::new(Runs::default()),
                ai_http: ai::ai_client(),
                dl_http: installer::download_client(),
                smoke_dir: smoke_dir.clone(),
                smoke_extras: smoke_extras.clone(),
                installing: tokio::sync::Mutex::new(()),
                streams: Mutex::new(HashMap::new()),
                play: Arc::new(play::Sites::default()),
            });
            // Mouse look in Play here: let the game's frame capture the pointer (see pointer_lock.rs).
            for window in app.webview_windows().values() {
                pointer_lock::allow(window);
            }
            Ok(())
        })
        // Play here: web builds for the Play view's sandboxed frame (see play.rs). Files are read off the
        // main thread; every answer allows any origin because the sandboxed frame's origin is opaque.
        .register_asynchronous_uri_scheme_protocol(play::SCHEME, |ctx, request, responder| {
            let state = ctx.app_handle().state::<AppState>();
            let (sites, smoke) = (state.play.clone(), state.smoke_dir.is_some());
            let (method, path) = (request.method().clone(), request.uri().path().to_string());
            std::thread::spawn(move || {
                let reply = if method == tauri::http::Method::GET || method == tauri::http::Method::HEAD {
                    play::respond(&sites, &path, smoke)
                } else {
                    play::Reply { status: 405, content_type: "text/plain", body: b"Method not allowed".to_vec() }
                };
                let response = tauri::http::Response::builder()
                    .status(reply.status)
                    .header("Content-Type", reply.content_type)
                    .header("Content-Length", reply.body.len())
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "no-store")
                    .header("X-Content-Type-Options", "nosniff")
                    .body(if method == tauri::http::Method::HEAD { Vec::new() } else { reply.body });
                match response {
                    Ok(r) => responder.respond(r),
                    Err(_) => responder.respond(tauri::http::Response::builder().status(500).body(Vec::new()).expect("empty response")),
                }
            });
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state = window.state::<AppState>();
                let mut granted = lock(&state.granted);
                for p in paths {
                    granted.insert(p.clone());
                }
                drop(granted);
                let list: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
                let _ = window.emit("files-dropped", list);
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info, settings_get, settings_set, pick_directory, pick_files, open_external, reveal_path,
            recents_list, recents_forget, project_create, project_open, project_close, project_files, project_read,
            project_write, project_trash, project_import, library_list, library_characters, library_sounds, library_thumbnail, library_download, page_fetch, unreal_sample_files, unreal_sample_add, snapshot_status, snapshot_list, snapshot_create, snapshot_restore,
            engines_discover, engine_install_godot, engine_install_godot_templates, engine_open_tool, run_start, run_stop, play_web_open, play_saves_read, play_saves_write, play_saves_clear, ai_providers, ai_generate, ai_stream_start, ai_stream_stop,
            audit_append, audit_list, smoke_finish, smoke_input, smoke_snapshot, smoke_picture, smoke_idle, smoke_windows
        ])
        .run(tauri::generate_context!())
        .expect("error while running Universal AI Game Studio");
}
