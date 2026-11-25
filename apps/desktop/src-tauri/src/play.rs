//! Play here: Godot web builds shown inside Game Studio.
//!
//! The Play view exports the project with its Web preset (the single-threaded template, so no
//! cross-origin isolation is needed) into the project's exports folder, then shows it in a sandboxed
//! frame. The frame loads from the gsplay: scheme, which serves only builds opened in this session,
//! each under an unguessable token: Game Studio's page (assets/play-shell.html), which starts the
//! engine and reports its output to the Play view, and the build's own files next to it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SCHEME: &str = "gsplay";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Site {
    pub dir: PathBuf,
    /// The build's file name without extension: Godot writes <stem>.js, <stem>.wasm, <stem>.pck.
    pub stem: String,
}

#[derive(Default)]
pub struct Sites(Mutex<HashMap<String, Site>>);

impl Sites {
    /// Serves a build folder under a new token, replacing an older token for the same folder.
    pub fn open(&self, dir: PathBuf, stem: String) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, s| s.dir != dir);
        map.insert(token.clone(), Site { dir, stem });
        token
    }

    pub fn get(&self, token: &str) -> Option<Site> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).get(token).cloned()
    }

    /// Stops serving every build inside a project folder (when the project closes).
    pub fn close_under(&self, root: &Path) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, s| !s.dir.starts_with(root));
    }
}

/// The page address for a token. WebView2 (Windows) reaches custom schemes as http://<scheme>.localhost.
pub fn site_url(token: &str) -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{token}/")
    } else {
        format!("{SCHEME}://localhost/{token}/")
    }
}

/// A build stem is a plain file name: it goes into the page's script tags and engine settings.
pub fn is_safe_stem(stem: &str) -> bool {
    !stem.is_empty() && stem.len() <= 64 && !stem.starts_with('.') && stem.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

fn not_found() -> Reply {
    Reply { status: 404, content_type: "text/plain", body: b"Not found".to_vec() }
}

/// Answers one gsplay request path: Game Studio's page at /<token>/, or a file of the build.
/// The self-test's isolation probe is served only in --smoke-test mode.
pub fn respond(sites: &Sites, path: &str, smoke: bool) -> Reply {
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let token = parts.next().unwrap_or("");
    let file = parts.next().unwrap_or("");
    let Some(site) = sites.get(token) else { return not_found() };
    match file {
        "" => Reply { status: 200, content_type: "text/html; charset=utf-8", body: shell_page(&site.stem).into_bytes() },
        "__probe.html" if smoke => Reply { status: 200, content_type: "text/html; charset=utf-8", body: include_str!("../assets/play-probe.html").as_bytes().to_vec() },
        name => serve_file(&site.dir, name),
    }
}

/// Game Studio's page for a build, with the saves stand-in (assets/play-saves.js) pasted in.
fn shell_page(stem: &str) -> String {
    include_str!("../assets/play-shell.html").replace("/*__SAVES__*/", include_str!("../assets/play-saves.js")).replace("__STEM__", stem)
}

fn serve_file(dir: &Path, name: &str) -> Reply {
    // One plain file of the build: no folders, no hidden files, only the kinds a web export has.
    if !is_safe_stem(name) {
        return not_found();
    }
    let content_type = match name.rsplit_once('.').map(|(_, ext)| ext) {
        Some("js") => "text/javascript",
        Some("wasm") => "application/wasm",
        Some("pck") => "application/octet-stream",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        _ => return not_found(),
    };
    // Refuse links that lead out of the build folder.
    match (dir.join(name).canonicalize(), dir.canonicalize()) {
        (Ok(file), Ok(base)) if file.starts_with(&base) && file.is_file() => match std::fs::read(&file) {
            Ok(body) => Reply { status: 200, content_type, body },
            Err(_) => not_found(),
        },
        _ => not_found(),
    }
}

/// The files a build needs before it can be played; returns the first one missing.
pub fn missing_file(dir: &Path, stem: &str) -> Option<String> {
    ["js", "wasm", "pck"].iter().map(|ext| format!("{stem}.{ext}")).find(|f| !dir.join(f).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build() -> (tempfile::TempDir, Sites, String) {
        let tmp = tempfile::tempdir().unwrap();
        let web = tmp.path().join("exports/web");
        std::fs::create_dir_all(&web).unwrap();
        for (f, body) in [("index.js", "js"), ("index.wasm", "wasm"), ("index.pck", "pck"), ("index.html", "godot page")] {
            std::fs::write(web.join(f), body).unwrap();
        }
        std::fs::write(tmp.path().join("secret.txt"), "secret").unwrap();
        let sites = Sites::default();
        let token = sites.open(web, "index".into());
        (tmp, sites, token)
    }

    #[test]
    fn serves_the_studio_page_and_the_build_files_only() {
        let (_tmp, sites, token) = build();
        let page = respond(&sites, &format!("/{token}/"), false);
        assert_eq!((page.status, page.content_type), (200, "text/html; charset=utf-8"));
        let html = String::from_utf8(page.body).unwrap();
        assert!(html.contains("<script src=\"index.js\"></script>") && html.contains("executable: \"index\"") && !html.contains("__STEM__"));
        assert!(html.contains("function gamestudioSaveStore(") && !html.contains("__SAVES__"));
        let wasm = respond(&sites, &format!("/{token}/index.wasm"), false);
        assert_eq!((wasm.status, wasm.content_type, wasm.body.as_slice()), (200, "application/wasm", b"wasm".as_slice()));
        assert_eq!(respond(&sites, &format!("/{token}/index.pck"), false).content_type, "application/octet-stream");
        for bad in ["../secret.txt", "..%2Fsecret.txt", "index.html", ".hidden.js", "sub/index.js", "secret.txt", "nothere.js"] {
            assert_eq!(respond(&sites, &format!("/{token}/{bad}"), false).status, 404, "{bad}");
        }
        assert_eq!(respond(&sites, "/not-a-token/index.js", false).status, 404);
        assert_eq!(respond(&sites, &format!("/{token}/__probe.html"), false).status, 404);
        assert_eq!(respond(&sites, &format!("/{token}/__probe.html"), true).status, 200);
    }

    #[test]
    fn refuses_links_out_of_the_build_folder() {
        let (tmp, sites, token) = build();
        std::os::unix::fs::symlink(tmp.path().join("secret.txt"), tmp.path().join("exports/web/leak.js")).unwrap();
        assert_eq!(respond(&sites, &format!("/{token}/leak.js"), false).status, 404);
    }

    #[test]
    fn replaces_and_closes_tokens() {
        let (tmp, sites, token) = build();
        let again = sites.open(tmp.path().join("exports/web"), "index".into());
        assert_ne!(token, again);
        assert!(sites.get(&token).is_none());
        assert!(sites.get(&again).is_some());
        assert_eq!(missing_file(&tmp.path().join("exports/web"), "index"), None);
        assert_eq!(missing_file(&tmp.path().join("exports/web"), "game"), Some("game.js".into()));
        sites.close_under(tmp.path());
        assert!(sites.get(&again).is_none());
        assert!(is_safe_stem("index") && is_safe_stem("my_game-1.2") && !is_safe_stem("a\"b") && !is_safe_stem("../x") && !is_safe_stem(""));
    }
}
