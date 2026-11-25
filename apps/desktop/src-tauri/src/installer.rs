use crate::engines::{parse_godot_version, run_with_timeout, templates_ready};
use crate::error::{AppError, AppResult};
use crate::projects::hex;
use serde::Serialize;
use sha2::{Digest, Sha512};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const INSTALL_EVENT: &str = "installer-progress";
const MAX_GODOT_DOWNLOAD: u64 = 600 * 1024 * 1024;
/// The 4.7.2 template archive is 1,281,349,702 bytes; anything past 2 GiB is refused.
const MAX_TEMPLATES_DOWNLOAD: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub stage: String,
    pub received: u64,
    pub total: Option<u64>,
    pub message: String,
}

pub fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    (2..=3).contains(&parts.len()) && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

fn release_base(version: &str) -> String {
    format!("https://github.com/godotengine/godot-builds/releases/download/{version}-stable")
}

pub fn release_urls(version: &str) -> (String, String, String) {
    let base = release_base(version);
    let file = format!("Godot_v{version}-stable_macos.universal.zip");
    (format!("{base}/SHA512-SUMS.txt"), format!("{base}/{file}"), file)
}

/// Export templates for every platform ship as one archive on the same release page.
pub fn templates_urls(version: &str) -> (String, String, String) {
    let base = release_base(version);
    let file = format!("Godot_v{version}-stable_export_templates.tpz");
    (format!("{base}/SHA512-SUMS.txt"), format!("{base}/{file}"), file)
}

pub fn find_checksum(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?;
        (name.trim_start_matches('*') == file && hash.len() == 128 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

/// HTTPS-only client that follows redirects only within GitHub's release hosts.
pub fn download_client() -> reqwest::Client {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str().unwrap_or("").to_string();
            if attempt.previous().len() > 5 {
                attempt.error("too many redirects")
            } else if attempt.url().scheme() == "https" && (host == "github.com" || host.ends_with(".githubusercontent.com")) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .connect_timeout(Duration::from_secs(20))
        .user_agent("UniversalAIGameStudio/0.1 (godot-installer)")
        .build()
        .expect("download client")
}

fn progress(app: &AppHandle, stage: &str, received: u64, total: Option<u64>, message: &str) {
    let _ = app.emit(INSTALL_EVENT, InstallProgress { stage: stage.into(), received, total, message: message.into() });
}

/// Progress callback (stage, bytes received, total bytes, message); the app forwards it to the window.
pub type Report<'a> = &'a (dyn Fn(&str, u64, Option<u64>, &str) + Send + Sync);

async fn official_checksum(client: &reqwest::Client, sums_url: &str, file: &str, version: &str) -> AppResult<String> {
    let sums = client.get(sums_url).send().await.map_err(|e| AppError::Unavailable(format!("Could not reach GitHub: {e}")))?;
    if !sums.status().is_success() {
        return Err(AppError::NotFound(format!("Godot {version} stable was not found on the official release page (HTTP {})", sums.status())));
    }
    let text = sums.text().await.map_err(|e| AppError::Unavailable(e.to_string()))?;
    find_checksum(&text, file).ok_or_else(|| AppError::NotFound(format!("The release has no checksum for {file}")))
}

pub fn sha512_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Download `url` to `dest`, hashing as it arrives; a mismatch deletes the file. A copy already at
/// `dest` (kept when a later step failed) is checked again and reused instead of downloaded twice.
pub async fn download_verified(report: Report<'_>, client: &reqwest::Client, url: &str, dest: &Path, expected: &str, max: u64, label: &str) -> AppResult<()> {
    if dest.is_file() {
        report("verifying", 0, None, "Checking the earlier download against the official checksum");
        let p = dest.to_path_buf();
        let hash = tauri::async_runtime::spawn_blocking(move || sha512_file(&p)).await.map_err(|e| AppError::Internal(e.to_string()))??;
        if hash == expected {
            return Ok(());
        }
        let _ = std::fs::remove_file(dest);
    }
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut resp = client.get(url).send().await.map_err(|e| AppError::Unavailable(format!("Download failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Unavailable(format!("Download failed (HTTP {})", resp.status())));
    }
    let total = resp.content_length();
    if total.map(|t| t > max).unwrap_or(false) {
        return Err(AppError::Invalid("The download is larger than expected; refusing it".into()));
    }
    let mut out = std::fs::File::create(&part)?;
    let mut hasher = Sha512::new();
    let mut received: u64 = 0;
    let mut last_report = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| AppError::Unavailable(format!("Download interrupted: {e}")))? {
        received += chunk.len() as u64;
        if received > max {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err(AppError::Invalid("The download grew larger than expected; stopped".into()));
        }
        hasher.update(&chunk);
        out.write_all(&chunk)?;
        if received - last_report >= 4 * 1024 * 1024 {
            last_report = received;
            report("downloading", received, total, label);
        }
    }
    out.sync_all()?;
    drop(out);
    report("verifying", received, total, "Checking the SHA-512 checksum");
    if hex(&hasher.finalize()) != expected {
        let _ = std::fs::remove_file(&part);
        return Err(AppError::Denied("The download does not match the official checksum and was deleted".into()));
    }
    std::fs::rename(&part, dest)?;
    Ok(())
}

/// Download, verify and install an official Godot release into the studio's engines folder.
/// The caller must have obtained the user's explicit approval for this download.
pub async fn install_godot(app: &AppHandle, client: &reqwest::Client, data_dir: &Path, version: &str) -> AppResult<PathBuf> {
    if !valid_version(version) {
        return Err(AppError::Invalid(format!("'{version}' is not a Godot version number")));
    }
    let engines = data_dir.join("engines");
    let dest_dir = engines.join(format!("godot/{version}-stable"));
    let dest_app = dest_dir.join("Godot.app");
    if dest_app.join("Contents/MacOS/Godot").is_file() {
        return Ok(dest_app);
    }
    let (sums_url, zip_url, file) = release_urls(version);
    progress(app, "checksums", 0, None, "Fetching the official checksum list");
    let expected = official_checksum(client, &sums_url, &file, version).await?;
    let downloads = engines.join("downloads");
    std::fs::create_dir_all(&downloads)?;
    let archive = downloads.join(&file);
    let report = |stage: &str, received: u64, total: Option<u64>, message: &str| progress(app, stage, received, total, message);
    download_verified(&report, client, &zip_url, &archive, &expected, MAX_GODOT_DOWNLOAD, "Downloading Godot").await?;

    progress(app, "extracting", 0, None, "Unpacking");
    let staging = engines.join(format!("godot/.extract-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staging)?;
    let unpack = {
        let archive = archive.clone();
        let staging = staging.clone();
        tauri::async_runtime::spawn_blocking(move || -> AppResult<PathBuf> {
            let status = Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(&archive).arg(&staging).status()?;
            if !status.success() {
                return Err(AppError::Internal("Could not unpack the download".into()));
            }
            let app = staging.join("Godot.app");
            if !app.is_dir() {
                return Err(AppError::Internal("The download did not contain Godot.app".into()));
            }
            let sig = Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(&app).status()?;
            if !sig.success() {
                return Err(AppError::Denied("Godot.app failed Apple code-signature verification".into()));
            }
            let (code, out, _) = run_with_timeout(&app.join("Contents/MacOS/Godot"), &["--version"], Duration::from_secs(30)).map_err(AppError::Internal)?;
            match (code, parse_godot_version(&out)) {
                (0, Some((v, channel, _))) if channel == "stable" && !v.is_empty() => Ok(app),
                _ => Err(AppError::Internal("The unpacked Godot did not report a stable version".into())),
            }
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    };
    let app_path = match unpack {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    std::fs::create_dir_all(&dest_dir)?;
    std::fs::rename(&app_path, &dest_app)?;
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&archive);
    progress(app, "done", 0, None, "Installed");
    Ok(dest_app)
}

/// Every entry must be a file or folder under `templates/`: no links, no absolute or parent paths.
pub fn check_template_entries(names: &str, long_listing: &str) -> Result<usize, String> {
    let mut count = 0;
    for name in names.lines().filter(|l| !l.is_empty()) {
        if !name.starts_with("templates/") || name.split('/').any(|s| s == "..") || name.contains('\\') || name.contains('\0') {
            return Err(format!("unexpected entry '{name}'"));
        }
        count += 1;
    }
    let is_link = |l: &str| l.starts_with('l') && l.chars().count() > 10 && l.chars().skip(1).take(9).all(|c| "rwxsStT-".contains(c));
    if long_listing.lines().any(is_link) {
        return Err("it contains a symbolic link".into());
    }
    if count == 0 {
        return Err("it is empty".into());
    }
    Ok(count)
}

fn zipinfo(args: &[&str], archive: &Path) -> AppResult<String> {
    let out = Command::new("/usr/bin/zipinfo").args(args).arg(archive).stdin(Stdio::null()).output()?;
    if !out.status.success() {
        return Err(AppError::Invalid("The template archive could not be read".into()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Unpack a verified template archive into `<root>/<folder>` (Godot's layout), never replacing an
/// existing folder. The archive is unpacked next to the destination and moved into place at the end.
pub fn extract_templates(archive: &Path, root: &Path, folder: &str) -> AppResult<PathBuf> {
    let dest = root.join(folder);
    if templates_ready(root, folder) {
        return Ok(dest);
    }
    if dest.exists() {
        return Err(AppError::Conflict(format!("{} exists but is incomplete. Remove it, then install again.", dest.display())));
    }
    check_template_entries(&zipinfo(&["-1"], archive)?, &zipinfo(&[], archive)?).map_err(|e| AppError::Denied(format!("The template archive was refused: {e}")))?;
    std::fs::create_dir_all(root)?;
    let staging = root.join(format!(".gamestudio-extract-{}", uuid::Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        std::fs::create_dir_all(&staging)?;
        let status = Command::new("/usr/bin/unzip").args(["-qq", "-o"]).arg(archive).arg("templates/*").arg("-d").arg(&staging).stdin(Stdio::null()).status()?;
        if !status.success() {
            return Err(AppError::Internal("Could not unpack the templates".into()));
        }
        let version = std::fs::read_to_string(staging.join("templates/version.txt")).unwrap_or_default();
        if version.trim() != folder {
            return Err(AppError::Invalid(format!("The archive holds templates for '{}', not {folder}", version.trim())));
        }
        if !staging.join("templates/macos.zip").is_file() {
            return Err(AppError::Invalid("The archive has no macOS template".into()));
        }
        std::fs::rename(staging.join("templates"), &dest)?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result.map(|_| dest)
}

/// Download, verify and install the official export templates for a Godot release into the folder
/// Godot reads them from. The caller must have obtained the user's explicit approval.
pub async fn install_godot_templates(app: &AppHandle, client: &reqwest::Client, data_dir: &Path, root: &Path, version: &str) -> AppResult<PathBuf> {
    if !valid_version(version) {
        return Err(AppError::Invalid(format!("'{version}' is not a Godot version number")));
    }
    let folder = format!("{version}.stable");
    if templates_ready(root, &folder) {
        return Ok(root.join(&folder));
    }
    let (sums_url, url, file) = templates_urls(version);
    progress(app, "checksums", 0, None, "Fetching the official checksum list");
    let expected = official_checksum(client, &sums_url, &file, version).await?;
    let downloads = data_dir.join("engines/downloads");
    std::fs::create_dir_all(&downloads)?;
    let archive = downloads.join(&file);
    let report = |stage: &str, received: u64, total: Option<u64>, message: &str| progress(app, stage, received, total, message);
    download_verified(&report, client, &url, &archive, &expected, MAX_TEMPLATES_DOWNLOAD, "Downloading export templates").await?;
    progress(app, "extracting", 0, None, "Unpacking the templates");
    let (a, r, f) = (archive.clone(), root.to_path_buf(), folder);
    let dest = tauri::async_runtime::spawn_blocking(move || extract_templates(&a, &r, &f)).await.map_err(|e| AppError::Internal(e.to_string()))??;
    let _ = std::fs::remove_file(&archive);
    progress(app, "done", 0, None, "Installed");
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_versions_and_builds_official_urls() {
        assert!(valid_version("4.7.2"));
        assert!(valid_version("4.7"));
        assert!(!valid_version("4.7.2-stable"));
        assert!(!valid_version("../../evil"));
        let (sums, zip, file) = release_urls("4.7.2");
        assert_eq!(sums, "https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable/SHA512-SUMS.txt");
        assert_eq!(zip, "https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable/Godot_v4.7.2-stable_macos.universal.zip");
        assert_eq!(file, "Godot_v4.7.2-stable_macos.universal.zip");
        let (tsums, tpz, tfile) = templates_urls("4.7.2");
        assert_eq!(tsums, sums);
        assert_eq!(tpz, "https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz");
        assert_eq!(tfile, "Godot_v4.7.2-stable_export_templates.tpz");
    }

    #[test]
    fn finds_only_well_formed_checksums_for_the_exact_file() {
        let good = "a".repeat(128);
        let sums = format!("{good}  Godot_v4.7.2-stable_macos.universal.zip\n{}  Godot_v4.7.2-stable_mono_macos.universal.zip\nshort  Other.zip\n", "b".repeat(128));
        assert_eq!(find_checksum(&sums, "Godot_v4.7.2-stable_macos.universal.zip"), Some(good));
        assert_eq!(find_checksum(&sums, "Other.zip"), None);
        assert_eq!(find_checksum(&sums, "Missing.zip"), None);
    }

    #[test]
    fn refuses_template_archives_with_unexpected_entries() {
        let long_ok = "Archive:  t.tpz\n-rw-r--r--  3.0 unx 13 tx defN 25-Aug-17 10:59 templates/version.txt\n";
        assert_eq!(check_template_entries("templates/version.txt\ntemplates/macos.zip\n", long_ok), Ok(2));
        for bad in ["templates/../evil", "/etc/passwd", "other/file", "templates\\x", "templates/a/../../b"] {
            assert!(check_template_entries(&format!("templates/version.txt\n{bad}\n"), long_ok).is_err(), "{bad}");
        }
        let long_link = "lrwxr-xr-x  3.0 unx 7 bx stor 25-Aug-17 10:59 templates/link\n";
        assert!(check_template_entries("templates/link\n", long_link).unwrap_err().contains("symbolic link"));
        assert!(check_template_entries("", "").is_err());
    }

    fn template_archive(dir: &Path, version: &str) -> PathBuf {
        let src = dir.join(format!("src-{version}"));
        std::fs::create_dir_all(src.join("templates")).unwrap();
        std::fs::write(src.join("templates/version.txt"), format!("{version}\n")).unwrap();
        std::fs::write(src.join("templates/macos.zip"), "mac").unwrap();
        std::fs::write(src.join("templates/web_release.zip"), "web").unwrap();
        let archive = dir.join(format!("{version}.tpz"));
        let status = Command::new("/usr/bin/zip").args(["-q", "-r"]).arg(&archive).arg("templates").current_dir(&src).status().unwrap();
        assert!(status.success());
        archive
    }

    #[test]
    fn extracts_templates_into_godots_layout_without_replacing_anything() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("export_templates");
        let archive = template_archive(dir.path(), "4.7.2.stable");
        let dest = extract_templates(&archive, &root, "4.7.2.stable").unwrap();
        assert_eq!(dest, root.join("4.7.2.stable"));
        assert_eq!(std::fs::read_to_string(dest.join("web_release.zip")).unwrap(), "web");
        assert!(templates_ready(&root, "4.7.2.stable"));
        assert_eq!(extract_templates(&archive, &root, "4.7.2.stable").unwrap(), dest, "already installed is fine");
        let leftovers: Vec<_> = std::fs::read_dir(&root).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        assert_eq!(leftovers.len(), 1, "no staging folder left behind: {leftovers:?}");

        let wrong = template_archive(dir.path(), "4.6.1.stable");
        assert!(matches!(extract_templates(&wrong, &root, "4.6.2.stable"), Err(AppError::Invalid(_))));
        assert!(!root.join("4.6.2.stable").exists());

        std::fs::create_dir_all(root.join("4.6.1.stable")).unwrap();
        std::fs::write(root.join("4.6.1.stable/mine.txt"), "keep").unwrap();
        assert!(matches!(extract_templates(&wrong, &root, "4.6.1.stable"), Err(AppError::Conflict(_))));
        assert_eq!(std::fs::read_to_string(root.join("4.6.1.stable/mine.txt")).unwrap(), "keep");
    }

    #[tokio::test]
    async fn reuses_a_verified_earlier_download_and_drops_a_bad_one() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Godot_v4.7.2-stable_export_templates.tpz");
        std::fs::write(&dest, "abc").unwrap();
        let expected = sha512_file(&dest).unwrap();
        let stages = std::sync::Mutex::new(Vec::<String>::new());
        let report = |stage: &str, _: u64, _: Option<u64>, _: &str| stages.lock().unwrap().push(stage.to_string());
        // Nothing listens on port 9, so reaching the network would fail the first call.
        let client = download_client();
        download_verified(&report, &client, "https://127.0.0.1:9/never", &dest, &expected, 10, "test").await.unwrap();
        assert_eq!(stages.lock().unwrap().as_slice(), ["verifying"]);
        std::fs::write(&dest, "tampered").unwrap();
        assert!(download_verified(&report, &client, "https://127.0.0.1:9/never", &dest, &expected, 10, "test").await.is_err());
        assert!(!dest.exists(), "a copy that fails the checksum is deleted");
        assert!(!dir.path().join("Godot_v4.7.2-stable_export_templates.tpz.part").exists());
    }

    /// Opt-in: GODOT_TEMPLATES_TPZ=/path/to/Godot_v4.7.2-stable_export_templates.tpz cargo test -- --ignored
    #[test]
    #[ignore]
    fn unpacks_the_real_template_archive() {
        let Some(archive) = std::env::var_os("GODOT_TEMPLATES_TPZ").map(PathBuf::from) else { return };
        let dir = tempfile::tempdir().unwrap();
        let dest = extract_templates(&archive, &dir.path().join("export_templates"), "4.7.2.stable").unwrap();
        let files = std::fs::read_dir(&dest).unwrap().count();
        assert_eq!(files, 35);
        assert_eq!(std::fs::metadata(dest.join("macos.zip")).unwrap().len(), 123_597_580);
        assert_eq!(sha512_file(&archive).unwrap(), "ca4d71c4d7b81dfc15d1a98baa07534aa95b03fdda78a0075b06672e1648d2e5f40980c9adc28d23e1b92e732ee7bf3461997aa804af74ec2fcd7a93ccb84079");
    }

    #[test]
    fn hashes_files_in_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x");
        std::fs::write(&p, "abc").unwrap();
        assert_eq!(sha512_file(&p).unwrap(), "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
    }
}
