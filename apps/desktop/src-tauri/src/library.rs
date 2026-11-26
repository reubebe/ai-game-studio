//! Free asset library (Poly Haven, CC0) and reading a web page someone links to as a game idea.
//!
//! Network rules, both features:
//! - Poly Haven requests go only to api.polyhaven.com, dl.polyhaven.org and cdn.polyhaven.com over
//!   HTTPS. Every downloaded file is checked against the size and MD5 the API lists, and written only
//!   inside the open project's engine assets folder, under names checked like any project path.
//! - A linked page is fetched over http(s) only, never from this computer or a private network
//!   (checked for the address the name resolves to and again after every redirect), at most 2 MB of
//!   text, and only its title, description and visible text come back. The text is given to the
//!   model as data, never as instructions.

use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use md5::{Digest as _, Md5};
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;

use crate::error::{AppError, AppResult};
use crate::paths;
use crate::projects::{atomic_write, hex, ImportedFile};

const API: &str = "https://api.polyhaven.com";
const USER_AGENT: &str = "UniversalAIGameStudio/0.1 (desktop app; asset browser)";
/// The most one download (a model with its textures) may add to a project.
const MAX_DOWNLOAD: u64 = 300 * 1024 * 1024;
const MAX_PAGE: usize = 2 * 1024 * 1024;
const MAX_PAGE_TEXT: usize = 12_000;

pub(crate) fn client(timeout: u64) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP client: {e}")))
}

pub(crate) fn net_err(what: &str) -> impl Fn(reqwest::Error) -> AppError + '_ {
    move |e| AppError::Unavailable(if e.is_timeout() { format!("{what} did not answer in time") } else { format!("Could not reach {what}") })
}

// ---- Poly Haven ------------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAsset {
    pub id: String,
    pub name: String,
    pub categories: Vec<String>,
    pub tags: Vec<String>,
    pub authors: Vec<String>,
    pub description: String,
    /// Model size in millimetres (x, y, z) when the library lists it.
    pub dimensions: Option<[f64; 3]>,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn allowed_download(url: &str) -> bool {
    Url::parse(url).map(|u| u.scheme() == "https" && u.host_str() == Some("dl.polyhaven.org")).unwrap_or(false)
}

pub fn parse_assets(json: &Value) -> Vec<LibraryAsset> {
    let Some(map) = json.as_object() else { return vec![] };
    let strings = |v: Option<&Value>| v.and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let mut out: Vec<LibraryAsset> = map
        .iter()
        .filter(|(id, _)| valid_id(id))
        .map(|(id, a)| LibraryAsset {
            id: id.clone(),
            name: a.get("name").and_then(|v| v.as_str()).unwrap_or(id).chars().take(120).collect(),
            categories: strings(a.get("categories")),
            tags: strings(a.get("tags")),
            authors: a.get("authors").and_then(|v| v.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default(),
            description: a.get("description").and_then(|v| v.as_str()).unwrap_or("").chars().take(400).collect(),
            dimensions: a.get("dimensions").and_then(|v| v.as_array()).filter(|d| d.len() == 3).and_then(|d| Some([d[0].as_f64()?, d[1].as_f64()?, d[2].as_f64()?])),
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

pub async fn list_assets(kind: &str) -> AppResult<Vec<LibraryAsset>> {
    let t = match kind {
        "models" | "textures" | "hdris" => kind,
        _ => return Err(AppError::Invalid("The library has models, textures and skies".into())),
    };
    let resp = client(30)?.get(format!("{API}/assets?type={t}")).send().await.map_err(net_err("Poly Haven"))?;
    if !resp.status().is_success() {
        return Err(AppError::Unavailable(format!("Poly Haven answered {}", resp.status())));
    }
    let json: Value = resp.json().await.map_err(|_| AppError::Unavailable("Poly Haven sent an unreadable list".into()))?;
    Ok(parse_assets(&json))
}

/// A small preview picture as a data: URL, so the studio's page never loads images from the internet.
pub async fn thumbnail(id: &str) -> AppResult<String> {
    if !valid_id(id) {
        return Err(AppError::Invalid("Unknown asset".into()));
    }
    let resp = client(20)?.get(format!("https://cdn.polyhaven.com/asset_img/thumbs/{id}.png?width=256&height=256")).send().await.map_err(net_err("Poly Haven"))?;
    if !resp.status().is_success() {
        return Err(AppError::NotFound("No preview".into()));
    }
    let mime = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_string();
    if !matches!(mime.as_str(), "image/png" | "image/webp" | "image/jpeg") {
        return Err(AppError::Invalid("The preview is not an image".into()));
    }
    let bytes = read_limited(resp, 1024 * 1024).await?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

pub(crate) async fn read_limited(mut resp: reqwest::Response, limit: usize) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| AppError::Unavailable("The download stopped".into()))? {
        if out.len() + chunk.len() > limit {
            return Err(AppError::Invalid("The file is larger than allowed".into()));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// One file to fetch: where it goes (relative to the destination folder), its URL, size and MD5.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub rel: String,
    pub url: String,
    pub size: u64,
    pub md5: String,
}

fn planned(rel: &str, entry: &Value) -> AppResult<Planned> {
    let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let md5 = entry.get("md5").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    let size = entry.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    if !allowed_download(url) || md5.len() != 32 || !md5.chars().all(|c| c.is_ascii_hexdigit()) || size == 0 {
        return Err(AppError::Invalid(format!("The library entry for {rel} is incomplete")));
    }
    if !paths::is_safe_relative(rel) || rel.split('/').any(|p| p.starts_with('.')) {
        return Err(AppError::Denied(format!("'{rel}' is not an allowed file name")));
    }
    Ok(Planned { rel: rel.to_string(), url: url.to_string(), size, md5 })
}

fn file_name(url: &str) -> String {
    Url::parse(url).ok().and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(String::from))).unwrap_or_default()
}

/// What to download for an asset at a resolution: a glTF model with the files it includes, a
/// texture set (colour, OpenGL normal and roughness maps as JPEG), or a photographed sky (one
/// Radiance .hdr panorama; the much larger .exr is never taken).
pub fn plan(kind: &str, id: &str, resolution: &str, files: &Value) -> AppResult<Vec<Planned>> {
    if !matches!(resolution, "1k" | "2k" | "4k") {
        return Err(AppError::Invalid("Choose 1k, 2k or 4k".into()));
    }
    let mut out = Vec::new();
    if kind == "models" {
        let g = files.pointer(&format!("/gltf/{resolution}/gltf")).ok_or_else(|| AppError::NotFound(format!("{id} has no {resolution} glTF download")))?;
        out.push(planned(&format!("{id}_{resolution}.gltf"), g)?);
        if let Some(inc) = g.get("include").and_then(|v| v.as_object()) {
            for (rel, e) in inc {
                out.push(planned(rel, e)?);
            }
        }
    } else if kind == "textures" {
        for map in ["Diffuse", "nor_gl", "Rough"] {
            if let Some(e) = files.pointer(&format!("/{map}/{resolution}/jpg")) {
                let name = file_name(e.get("url").and_then(|v| v.as_str()).unwrap_or(""));
                out.push(planned(&name, e)?);
            }
        }
        if out.is_empty() {
            return Err(AppError::NotFound(format!("{id} has no {resolution} JPEG maps")));
        }
    } else if kind == "hdris" {
        let e = files.pointer(&format!("/hdri/{resolution}/hdr")).ok_or_else(|| AppError::NotFound(format!("{id} has no {resolution} sky picture")))?;
        let name = file_name(e.get("url").and_then(|v| v.as_str()).unwrap_or(""));
        if !name.to_ascii_lowercase().ends_with(".hdr") {
            return Err(AppError::Denied("A sky is downloaded as a .hdr picture only".into()));
        }
        out.push(planned(&name, e)?);
    } else {
        return Err(AppError::Invalid("The library has models, textures and skies".into()));
    }
    let total: u64 = out.iter().map(|p| p.size).sum();
    if total > MAX_DOWNLOAD {
        return Err(AppError::Invalid(format!("That download is {} MB; choose a smaller resolution", total / 1024 / 1024)));
    }
    Ok(out)
}

/// Downloads an asset into `<root>/<dest_dir>/<id>/`, checking each file's size and MD5 before
/// anything is written. Returns the files, relative to the project root.
pub async fn download(root: &Path, dest_dir: &str, kind: &str, id: &str, resolution: &str) -> AppResult<Vec<ImportedFile>> {
    if !valid_id(id) {
        return Err(AppError::Invalid("Unknown asset".into()));
    }
    if !paths::is_safe_relative(dest_dir) {
        return Err(AppError::Denied("Not an allowed folder".into()));
    }
    let http = client(300)?;
    let resp = http.get(format!("{API}/files/{id}")).send().await.map_err(net_err("Poly Haven"))?;
    if !resp.status().is_success() {
        return Err(AppError::NotFound(format!("Poly Haven has no files for {id}")));
    }
    let files: Value = resp.json().await.map_err(|_| AppError::Unavailable("Poly Haven sent an unreadable file list".into()))?;
    let list = plan(kind, id, resolution, &files)?;
    let mut fetched: Vec<(Planned, Vec<u8>)> = Vec::new();
    for p in list {
        let resp = http.get(&p.url).send().await.map_err(net_err("Poly Haven"))?;
        if !resp.status().is_success() {
            return Err(AppError::Unavailable(format!("{} answered {}", p.rel, resp.status())));
        }
        let bytes = read_limited(resp, p.size as usize + 1).await?;
        if bytes.len() as u64 != p.size || hex(&Md5::digest(&bytes)) != p.md5 {
            return Err(AppError::Invalid(format!("{} did not match the library's checksum; nothing was saved", p.rel)));
        }
        fetched.push((p, bytes));
    }
    let mut out = Vec::new();
    for (p, bytes) in fetched {
        let rel = format!("{dest_dir}/{id}/{}", p.rel);
        let path = paths::resolve_in_root(root, &rel)?;
        atomic_write(&path, &bytes)?;
        out.push(ImportedFile { path: rel, source_name: format!("https://polyhaven.com/a/{id}"), bytes: bytes.len() as u64, sha256: hex(&Sha256::digest(&bytes)) });
    }
    Ok(out)
}

// ---- Animated characters ------------------------------------------------------------------------

/// One file of a catalogue character, at a pinned address, with its size and SHA-256.
#[derive(Debug, Clone)]
pub struct CatalogFile {
    pub rel: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

/// A free animated character from fixed, pinned files. Poly Haven has no characters, so these come
/// from well-known open collections; each URL names an exact release or commit and every file must
/// match its size and SHA-256 before anything is written.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCharacter {
    pub id: &'static str,
    /// For a realistic person: how Godot turns the downloaded files into one .glb (see Conversion).
    #[serde(skip)]
    pub convert: Option<&'static Conversion>,
    /// Whether adding it needs Godot (it is converted on this computer after downloading).
    pub needs_godot: bool,
    pub name: &'static str,
    /// The model file, relative to the character's folder.
    pub main: &'static str,
    #[serde(skip)]
    pub files: &'static [CatalogFile],
    pub bytes: u64,
    pub license: &'static str,
    pub author: &'static str,
    pub source: &'static str,
    pub clips: &'static [&'static str],
    /// A height that suits it, in metres.
    pub height: f64,
    pub description: &'static str,
}

/// A Microsoft Rocketbox person (MIT): an FBX with .tga textures and separate FBX animations of the same
/// rig. Game Studio and its games read glTF, so after downloading (each file checked as usual) Godot turns
/// them into one .glb with textures at most `texture_size` pixels across and the animations named Idle,
/// Walk and Run (assets/convert_character.gd), and the MIT notice is saved beside it.
#[derive(Debug)]
pub struct Conversion {
    /// The person's FBX, one of the character's files.
    pub person: &'static str,
    /// (clip name, animation FBX among the files).
    pub clips: &'static [(&'static str, &'static str)],
    pub texture_size: u32,
}

const CONVERTER: &str = include_str!("../assets/convert_character.gd");
pub(crate) const ROCKETBOX_LICENSE: &str = "Microsoft Rocketbox avatar library (https://github.com/microsoft/Microsoft-Rocketbox),\nconverted to glTF by Game Studio.\n\nMIT License\n\nCopyright (c) 2020 Microsoft\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n";

const WOMAN: Conversion = Conversion {
    person: "Female_Adult_01.fbx",
    clips: &[("Idle", "f_idle_neutral_01.max.fbx"), ("Walk", "f_walk_neutral_01.max.fbx"), ("Run", "f_run_neutral_01.max.fbx")],
    texture_size: 1024,
};
const MAN: Conversion = Conversion {
    person: "Male_Adult_01.fbx",
    clips: &[("Idle", "m_idle_neutral_01.max.fbx"), ("Walk", "m_walk_neutral_01.max.fbx"), ("Run", "m_run_neutral_01.max.fbx")],
    texture_size: 1024,
};

pub const CHARACTERS: &[CatalogCharacter] = &[
    CatalogCharacter {
        id: "robot-expressive",
        convert: None,
        needs_godot: false,
        name: "Robot (expressive)",
        main: "RobotExpressive.glb",
        files: &[CatalogFile { rel: "RobotExpressive.glb", url: "https://raw.githubusercontent.com/mrdoob/three.js/r187/examples/models/gltf/RobotExpressive/RobotExpressive.glb", sha256: "047f5e5fb3bb6d378bd1df16ca6137f2a596c99b3a1b5690b4020c05aaf6f319", bytes: 463_988 }],
        bytes: 463_988,
        license: "CC0 1.0",
        author: "Tomás Laulhé (Quaternius); changes by Don McCurdy",
        source: "https://github.com/mrdoob/three.js/tree/r187/examples/models/gltf/RobotExpressive",
        clips: &["Dance", "Death", "Idle", "Jump", "No", "Punch", "Running", "Sitting", "Standing", "ThumbsUp", "Walking", "WalkJump", "Wave", "Yes"],
        height: 1.8,
        description: "A friendly robot with idle, walk, run, jump, wave, dance and more.",
    },
    CatalogCharacter {
        id: "kenney-character",
        convert: None,
        needs_godot: false,
        name: "Kenney platformer character",
        main: "character.glb",
        files: &[
            CatalogFile { rel: "character.glb", url: "https://raw.githubusercontent.com/KenneyNL/Starter-Kit-3D-Platformer/3fa8a04b1c01ab23db43123d4ce814a34c3fc7f0/models/character.glb", sha256: "7112f6a08400914f9da546f3e6029e947cc9eab2b4a6da5eb99776111289efb1", bytes: 87_624 },
            CatalogFile { rel: "Textures/colormap.png", url: "https://raw.githubusercontent.com/KenneyNL/Starter-Kit-3D-Platformer/3fa8a04b1c01ab23db43123d4ce814a34c3fc7f0/models/Textures/colormap.png", sha256: "106cf02e0d6dccded6d9f90c2ae6a51eb94c6301645fea159e834c44ed4708a3", bytes: 10_108 },
        ],
        bytes: 97_732,
        license: "CC0 1.0",
        author: "Kenney (kenney.nl)",
        source: "https://github.com/KenneyNL/Starter-Kit-3D-Platformer/tree/3fa8a04b1c01ab23db43123d4ce814a34c3fc7f0/models",
        clips: &["static", "idle", "walk", "jump"],
        height: 1.0,
        description: "A small cartoon hero from Kenney's 3D platformer kit, with idle, walk and jump.",
    },
    CatalogCharacter {
        id: "fox",
        convert: None,
        needs_godot: false,
        name: "Fox",
        main: "Fox.glb",
        files: &[CatalogFile { rel: "Fox.glb", url: "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/f0920f5b32d172a30efe3f9257e965918831e6ea/Models/Fox/glTF-Binary/Fox.glb", sha256: "d97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7", bytes: 162_852 }],
        bytes: 162_852,
        license: "Model CC0 1.0 (PixelMannen); rigging and animation CC BY 4.0 (tomkranis); glTF version CC BY 4.0 (@AsoboStudio, @scurest)",
        author: "PixelMannen; tomkranis; @AsoboStudio and @scurest",
        source: "https://github.com/KhronosGroup/glTF-Sample-Assets/tree/f0920f5b32d172a30efe3f9257e965918831e6ea/Models/Fox",
        clips: &["Survey", "Walk", "Run"],
        height: 0.8,
        description: "A low-poly fox that looks around, walks and runs. CC BY parts need credit in your game.",
    },
    CatalogCharacter {
        id: "godette",
        convert: None,
        needs_godot: false,
        name: "Godette (anime, VRM)",
        main: "Godette.vrm",
        files: &[CatalogFile { rel: "Godette.vrm", url: "https://raw.githubusercontent.com/V-Sekai/godot-vrm/e15199f980064028bfa4fbee5e70dddb82dd55c3/vrm_samples/Godette_vrm_v4.vrm", sha256: "0b008f60c808eb1c83781c650e654a70d512574932e3867f80609c62d7052c6c", bytes: 591_288 }],
        bytes: 591_288,
        license: "CC BY 3.0 (original model by SirRichard94; VRM adaptation by Lyuma)",
        author: "SirRichard94; Lyuma",
        source: "https://github.com/V-Sekai/godot-vrm/tree/e15199f980064028bfa4fbee5e70dddb82dd55c3/vrm_samples",
        clips: &["Idle", "Walk", "Run", "Jump"],
        height: 1.5,
        description: "Godot's mascot as an anime VRM character with toon shading and moving hair. She walks, runs and jumps with Game Studio's humanoid animations. CC BY: credit SirRichard94 and Lyuma in your game.",
    },
    CatalogCharacter {
        id: "rocketbox-woman",
        convert: Some(&WOMAN),
        needs_godot: true,
        name: "Woman (realistic, Rocketbox)",
        main: "rocketbox-woman.glb",
        files: &[
            CatalogFile { rel: "Female_Adult_01.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_01/Export/Female_Adult_01.fbx"), sha256: "8cbaf86576004b96469bc80df123b97fef788f4a7bb3f3eaa616fcfaf55698a3", bytes: 609_152 },
            CatalogFile { rel: "f001_body_color.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_01/Textures/f001_body_color.tga"), sha256: "c038b01c5d05831c3f4e8c6daa18394e8a4851372acd3fcbdf30e7ee53c56cae", bytes: 12_582_956 },
            CatalogFile { rel: "f001_body_normal.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_01/Textures/f001_body_normal.tga"), sha256: "86b9b5a5aa73bd97244b35f97f3799c31b3db70426d7d607cbdc2dd271ace346", bytes: 12_582_956 },
            CatalogFile { rel: "f001_head_color.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_01/Textures/f001_head_color.tga"), sha256: "0d3153c59c54908d5f5194ffe3a7d882351f0dd74f9ef44ab3a2f164a3bf9d8e", bytes: 12_582_956 },
            CatalogFile { rel: "f001_head_normal.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_01/Textures/f001_head_normal.tga"), sha256: "522f3372283ea4161ed56d85471be15e02628df73a966447e4456bc169d310b2", bytes: 12_582_956 },
            CatalogFile { rel: "f001_opacity_color.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_01/Textures/f001_opacity_color.tga"), sha256: "12c9c366814e665687fe64056421213686b50a972a5ad47295f247d6a8ff7369", bytes: 16_777_260 },
            CatalogFile { rel: "f_idle_neutral_01.max.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Animations/all_animations_max_motextr_static/f_idle_neutral_01.max.fbx"), sha256: "fd68b33ea9e290dc734ca8c3a71ef5842bb2dfe719853ff84f6336d06d39fdcb", bytes: 2_959_360 },
            CatalogFile { rel: "f_walk_neutral_01.max.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Animations/all_animations_max_motextr_xy/f_walk_neutral_01.max.fbx"), sha256: "20238709c689d46f5864aebaa58918cc1233cb9045b24aa4d58cf2752786a73b", bytes: 993_792 },
            CatalogFile { rel: "f_run_neutral_01.max.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Animations/all_animations_max_motextr_xy/f_run_neutral_01.max.fbx"), sha256: "f615a83d50f2b5671877c7449bce557885f4575517b6d83d588b16428f913e51", bytes: 877_504 },
        ],
        bytes: 72_548_892,
        license: "MIT (Microsoft Rocketbox)",
        author: "Microsoft (Rocketbox avatar library)",
        source: "https://github.com/microsoft/Microsoft-Rocketbox/tree/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Avatars/Adults/Female_Adult_01",
        clips: &["Idle", "Walk", "Run"],
        height: 1.7,
        description: "A realistic woman with motion-captured idle, walk and run. About 73 MB to download; Godot turns it into one 8 MB model on this computer. MIT: the licence notice is saved beside it.",
    },
    CatalogCharacter {
        id: "rocketbox-man",
        convert: Some(&MAN),
        needs_godot: true,
        name: "Man (realistic, Rocketbox)",
        main: "rocketbox-man.glb",
        files: &[
            CatalogFile { rel: "Male_Adult_01.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Male_Adult_01/Export/Male_Adult_01.fbx"), sha256: "8d1edb51b4dc3427ae2456f4407fc105532c145dd019e53cd42bab31cc948a29", bytes: 521_472 },
            CatalogFile { rel: "m002_body_color.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Male_Adult_01/Textures/m002_body_color.tga"), sha256: "6a048a6b2140a1f5293798ca286be64fd0de6d79572e1273ff5765bd578f463f", bytes: 12_582_956 },
            CatalogFile { rel: "m002_body_normal.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Male_Adult_01/Textures/m002_body_normal.tga"), sha256: "c9892e80c56890f6f5365627835286c2d4d2cc34cc473f6788fe3d560a52fb69", bytes: 12_582_956 },
            CatalogFile { rel: "m002_head_color.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Male_Adult_01/Textures/m002_head_color.tga"), sha256: "f5b64e4894930d438f7c419c3c9d0bba1f95fa4de9af078b762ea55bfca1ab85", bytes: 12_582_956 },
            CatalogFile { rel: "m002_head_normal.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Male_Adult_01/Textures/m002_head_normal.tga"), sha256: "5ef5ae404c9276f17641e392d0d4bdbe5fb23e94f28238b23a381e6a357c42ea", bytes: 12_582_956 },
            CatalogFile { rel: "m002_opacity_color.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Male_Adult_01/Textures/m002_opacity_color.tga"), sha256: "53818d3f45519451edd2bc60d6e59cd4057ecd381827463c5503da0439d0a5cf", bytes: 16_777_260 },
            CatalogFile { rel: "m_idle_neutral_01.max.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Animations/all_animations_max_motextr_static/m_idle_neutral_01.max.fbx"), sha256: "818cc185af21390575f7fbfdeb3012ba2ce5969fbcb220ea725a2617b339a6e2", bytes: 2_418_544 },
            CatalogFile { rel: "m_walk_neutral_01.max.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Animations/all_animations_max_motextr_xy/m_walk_neutral_01.max.fbx"), sha256: "e6805ae6b6b49fe10f06c1b17b14ddde90d09b9fea689ac34793df252f44dcd0", bytes: 994_336 },
            CatalogFile { rel: "m_run_neutral_01.max.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Animations/all_animations_max_motextr_xy/m_run_neutral_01.max.fbx"), sha256: "5a22052ea750805ea7e097310f36cd448c838e7c88bc842a78632d9606869fa8", bytes: 868_752 },
        ],
        bytes: 71_912_188,
        license: "MIT (Microsoft Rocketbox)",
        author: "Microsoft (Rocketbox avatar library)",
        source: "https://github.com/microsoft/Microsoft-Rocketbox/tree/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Avatars/Adults/Male_Adult_01",
        clips: &["Idle", "Walk", "Run"],
        height: 1.8,
        description: "A realistic man with motion-captured idle, walk and run. About 72 MB to download; Godot turns it into one 7 MB model on this computer. MIT: the licence notice is saved beside it.",
    },
];

/// Downloads a catalogue character into `<root>/<dest_dir>/<id>/`, checking every file's size and
/// SHA-256 before any of them is written. The first file returned is the model.
pub async fn download_character(root: &Path, dest_dir: &str, id: &str, godot: Option<&Path>) -> AppResult<Vec<ImportedFile>> {
    let c = CHARACTERS.iter().find(|c| c.id == id).ok_or_else(|| AppError::NotFound("No such character in the library".into()))?;
    if !paths::is_safe_relative(dest_dir) {
        return Err(AppError::Denied("Not an allowed folder".into()));
    }
    if c.convert.is_some() && godot.is_none() {
        return Err(AppError::Unavailable(format!("{} is converted with Godot after downloading; install Godot in Engines first", c.name)));
    }
    let http = client(120)?;
    let mut fetched = Vec::new();
    for f in c.files {
        let resp = http.get(f.url).send().await.map_err(net_err("GitHub"))?;
        if !resp.status().is_success() {
            return Err(AppError::Unavailable(format!("{} answered {}", f.rel, resp.status())));
        }
        let bytes = read_limited(resp, f.bytes as usize + 1).await?;
        let sha = hex(&Sha256::digest(&bytes));
        if bytes.len() as u64 != f.bytes || sha != f.sha256 {
            return Err(AppError::Invalid(format!("{} did not match the library's checksum; nothing was saved", f.rel)));
        }
        fetched.push((f, bytes, sha));
    }
    if let (Some(conv), Some(godot)) = (c.convert, godot) {
        return convert_character(root, dest_dir, c, conv, godot, fetched).await;
    }
    let mut out = Vec::new();
    for (f, bytes, sha) in fetched {
        let rel = format!("{dest_dir}/{}/{}", c.id, f.rel);
        let path = paths::resolve_in_root(root, &rel)?;
        atomic_write(&path, &bytes)?;
        out.push(ImportedFile { path: rel, source_name: c.source.to_string(), bytes: bytes.len() as u64, sha256: sha });
    }
    Ok(out)
}

/// Turns a Rocketbox person's checked files into one .glb with Godot (assets/convert_character.gd) in a
/// folder of its own, then saves the .glb and the MIT notice into the project. Godot's own data goes to that
/// folder too (HOME points there), so nothing is left behind.
async fn convert_character(root: &Path, dest_dir: &str, c: &CatalogCharacter, conv: &Conversion, godot: &Path, fetched: Vec<(&CatalogFile, Vec<u8>, String)>) -> AppResult<Vec<ImportedFile>> {
    let work = std::env::temp_dir().join(format!("gamestudio-character-{}", uuid::Uuid::new_v4()));
    let result = async {
        let files = work.join("files");
        let project = work.join("converter");
        std::fs::create_dir_all(&files)?;
        std::fs::create_dir_all(&project)?;
        for (f, bytes, _) in &fetched {
            if !paths::is_safe_relative(f.rel) || f.rel.contains('/') {
                return Err(AppError::Denied(format!("'{}' is not an allowed file name", f.rel)));
            }
            std::fs::write(files.join(f.rel), bytes)?;
        }
        std::fs::write(project.join("project.godot"), "config_version=5\n\n[application]\nconfig/name=\"Game Studio character converter\"\n")?;
        std::fs::write(project.join("convert_character.gd"), CONVERTER)?;
        let out_glb = work.join("out.glb");
        let mut args: Vec<String> = vec!["--headless".into(), "--path".into(), project.to_string_lossy().into(), "--script".into(), "res://convert_character.gd".into(), "--".into(), files.to_string_lossy().into(), conv.person.into(), out_glb.to_string_lossy().into(), conv.texture_size.to_string()];
        for (name, file) in conv.clips {
            args.push(format!("{name}={file}"));
        }
        let home: PathBuf = work.join("home");
        std::fs::create_dir_all(&home)?;
        let run = tokio::process::Command::new(godot).args(&args).env("HOME", &home).output();
        let output = tokio::time::timeout(Duration::from_secs(600), run).await.map_err(|_| AppError::Unavailable("Converting the character took too long".into()))??;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.lines().any(|l| l.starts_with("CONVERTED ")) {
            let reason = stdout.lines().find_map(|l| l.strip_prefix("CONVERT_FAILED ")).unwrap_or("Godot did not finish the conversion");
            return Err(AppError::Unavailable(format!("{}: {reason}", c.name)));
        }
        let glb = std::fs::read(&out_glb)?;
        if glb.len() < 12 || &glb[0..4] != b"glTF" {
            return Err(AppError::Invalid(format!("{}: the converted model is not a glTF file", c.name)));
        }
        let mut out = Vec::new();
        for (name, bytes) in [(c.main, glb), ("LICENSE.txt", ROCKETBOX_LICENSE.as_bytes().to_vec())] {
            let rel = format!("{dest_dir}/{}/{name}", c.id);
            let path = paths::resolve_in_root(root, &rel)?;
            atomic_write(&path, &bytes)?;
            out.push(ImportedFile { path: rel, source_name: c.source.to_string(), bytes: bytes.len() as u64, sha256: hex(&Sha256::digest(&bytes)) });
        }
        Ok(out)
    }
    .await;
    let _ = std::fs::remove_dir_all(&work);
    result
}

// ---- Sound effects ------------------------------------------------------------------------------

/// A free sound effect from a fixed, pinned file (Kenney's 3D platformer kit, whose README states
/// its sound effects are CC0), checked against its size and SHA-256 before it is written.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSound {
    pub id: &'static str,
    pub name: &'static str,
    pub file: &'static str,
    #[serde(skip)]
    pub url: &'static str,
    #[serde(skip)]
    pub sha256: &'static str,
    pub bytes: u64,
    pub seconds: f64,
    pub license: &'static str,
    pub author: &'static str,
    pub source: &'static str,
    pub description: &'static str,
}

macro_rules! kenney_sound {
    ($id:literal, $name:literal, $file:literal, $sha:literal, $bytes:literal, $secs:literal, $desc:literal) => {
        CatalogSound {
            id: $id,
            name: $name,
            file: $file,
            url: concat!("https://raw.githubusercontent.com/KenneyNL/Starter-Kit-3D-Platformer/3fa8a04b1c01ab23db43123d4ce814a34c3fc7f0/sounds/", $file),
            sha256: $sha,
            bytes: $bytes,
            seconds: $secs,
            license: "CC0 1.0",
            author: "Kenney (kenney.nl)",
            source: "https://github.com/KenneyNL/Starter-Kit-3D-Platformer/tree/3fa8a04b1c01ab23db43123d4ce814a34c3fc7f0/sounds",
            description: $desc,
        }
    };
}

pub const SOUNDS: &[CatalogSound] = &[
    kenney_sound!("kenney-coin", "Coin", "coin.ogg", "df55e931e6b78e5aecc015922e873a0e8bfa4e97cfb19abc64149d54afe89216", 6620, 0.29, "A bright pickup sound."),
    kenney_sound!("kenney-jump", "Jump", "jump.ogg", "f090c16689e9ec04c4bef80bfcbf68bc4b63ab4ce29f7fbb5cee05a5641d5694", 5805, 0.17, "A short hop."),
    kenney_sound!("kenney-land", "Land", "land.ogg", "145a1c17125dc4d344ac135bc5073e35ea12e19700ca30ee6e1e477010b4dca0", 5885, 0.06, "A soft landing thud."),
    kenney_sound!("kenney-fall", "Fall", "fall.ogg", "e5d4c5b36e738eeb55ee9c8deffd526af313623e50580a096302021c4e138268", 11313, 0.14, "A quick drop, for being hurt."),
    kenney_sound!("kenney-break", "Break", "break.ogg", "51157b7441fca84fea95d4e93d6a9a3b91efa870b602e5c56a76e3ab639686a7", 10784, 0.42, "Something crumbling, for a stomp or a gate."),
    kenney_sound!("kenney-walking", "Footsteps", "walking.ogg", "e4043660b7bc15bd1ec208c4193838da5a2618bde6f35e3d76654557268aa221", 10929, 0.9, "A short loop of footsteps."),
];

/// Downloads a catalogue sound into `<root>/<dest_dir>/<file>` after checking its size and SHA-256.
pub async fn download_sound(root: &Path, dest_dir: &str, id: &str) -> AppResult<Vec<ImportedFile>> {
    let c = SOUNDS.iter().find(|c| c.id == id).ok_or_else(|| AppError::NotFound("No such sound in the library".into()))?;
    if !paths::is_safe_relative(dest_dir) {
        return Err(AppError::Denied("Not an allowed folder".into()));
    }
    let resp = client(60)?.get(c.url).send().await.map_err(net_err("GitHub"))?;
    if !resp.status().is_success() {
        return Err(AppError::Unavailable(format!("{} answered {}", c.name, resp.status())));
    }
    let bytes = read_limited(resp, c.bytes as usize + 1).await?;
    let sha = hex(&Sha256::digest(&bytes));
    if bytes.len() as u64 != c.bytes || sha != c.sha256 {
        return Err(AppError::Invalid(format!("{} did not match the library's checksum; nothing was saved", c.name)));
    }
    let rel = format!("{dest_dir}/{}", c.file);
    let path = paths::resolve_in_root(root, &rel)?;
    atomic_write(&path, &bytes)?;
    Ok(vec![ImportedFile { path: rel, source_name: c.source.to_string(), bytes: bytes.len() as u64, sha256: sha }])
}

// ---- Reading a linked page --------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    pub url: String,
    pub title: String,
    pub description: String,
    pub text: String,
}

/// Addresses a linked page may not use: this computer, private networks, link-local and the like.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_loopback() || v.is_private() || v.is_link_local() || v.is_broadcast() || v.is_unspecified() || v.is_documentation() || o[0] == 0 || (o[0] == 100 && (64..128).contains(&o[1])) || o[0] >= 224 || (o[0] == 198 && (o[1] == 18 || o[1] == 19)))
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(m));
            }
            let s = v.segments();
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80)
        }
    }
}

fn check_url(raw: &str) -> AppResult<Url> {
    let url = Url::parse(raw.trim()).map_err(|_| AppError::Invalid("That is not a web address".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::Denied("Only http and https links can be read".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::Denied("Links with a user name or password are not read".into()));
    }
    let host = url.host_str().ok_or_else(|| AppError::Invalid("The link has no host".into()))?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") {
        return Err(AppError::Denied("Links to this computer or a local network are not read".into()));
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<IpAddr> = (host.trim_matches(|c| c == '[' || c == ']'), port).to_socket_addrs().map_err(|_| AppError::Unavailable(format!("Could not find {host}")))?.map(|a| a.ip()).collect();
    if addrs.is_empty() || !addrs.iter().all(|ip| is_public_ip(*ip)) {
        return Err(AppError::Denied("Links to this computer or a private network are not read".into()));
    }
    Ok(url)
}

pub async fn fetch_page(raw: &str) -> AppResult<PageText> {
    let http = client(20)?;
    let first = raw.to_string();
    let mut url = tokio::task::spawn_blocking(move || check_url(&first)).await.map_err(|e| AppError::Internal(e.to_string()))??;
    for _ in 0..5 {
        let u = url.clone();
        let resp = http.get(u.clone()).header("accept", "text/html, text/plain;q=0.9").send().await.map_err(net_err("that site"))?;
        if resp.status().is_redirection() {
            let next = resp.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| AppError::Unavailable("The site redirected without saying where".into()))?;
            let target = u.join(next).map_err(|_| AppError::Invalid("The site redirected to an invalid address".into()))?;
            url = tokio::task::spawn_blocking(move || check_url(target.as_str())).await.map_err(|e| AppError::Internal(e.to_string()))??;
            continue;
        }
        if !resp.status().is_success() {
            return Err(AppError::Unavailable(format!("The site answered {}", resp.status())));
        }
        let mime = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
        if !(mime.starts_with("text/html") || mime.starts_with("text/plain") || mime.starts_with("application/xhtml")) {
            return Err(AppError::Invalid("The link is not a web page".into()));
        }
        let bytes = read_limited_lossy(resp, MAX_PAGE).await?;
        let body = String::from_utf8_lossy(&bytes);
        let mut page = if mime.starts_with("text/plain") { PageText { url: String::new(), title: String::new(), description: String::new(), text: clip(&collapse(&body), MAX_PAGE_TEXT) } } else { page_text(&body) };
        page.url = u.to_string();
        return Ok(page);
    }
    Err(AppError::Unavailable("The site redirected too many times".into()))
}

/// Like read_limited, but a page longer than the limit is cut there instead of refused.
async fn read_limited_lossy(mut resp: reqwest::Response, limit: usize) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| AppError::Unavailable("The page stopped loading".into()))? {
        let room = limit.saturating_sub(out.len());
        out.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(s: &str) -> String {
    let named: HashMap<&str, &str> = [("amp", "&"), ("lt", "<"), ("gt", ">"), ("quot", "\""), ("apos", "'"), ("#39", "'"), ("nbsp", " "), ("mdash", "-"), ("ndash", "-"), ("hellip", "…"), ("rsquo", "'"), ("lsquo", "'"), ("ldquo", "\""), ("rdquo", "\"")].into_iter().collect();
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        match tail.find(';').filter(|&j| j <= 8) {
            Some(j) => {
                let name = &tail[..j];
                let decoded = named.get(name).map(|s| s.to_string()).or_else(|| {
                    let n = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")).and_then(|h| u32::from_str_radix(h, 16).ok()).or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))?;
                    char::from_u32(n).map(String::from)
                });
                match decoded {
                    Some(d) => {
                        out.push_str(&d);
                        rest = &tail[j + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = tail;
                    }
                }
            }
            None => {
                out.push('&');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Removes every `<tag ...>...</tag>` block for the given tag names (case-insensitive).
fn strip_blocks(html: &str, tags: &[&str]) -> String {
    let mut s = html.to_string();
    for tag in tags {
        loop {
            let lower = s.to_lowercase();
            let Some(start) = lower.find(&format!("<{tag}")) else { break };
            let end = lower[start..].find(&format!("</{tag}")).and_then(|e| lower[start + e..].find('>').map(|g| start + e + g + 1)).unwrap_or(s.len());
            s.replace_range(start..end, " ");
        }
    }
    s
}

fn meta_content(html: &str, lower: &str, key: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = lower[from..].find("<meta") {
        let at = from + i;
        let end = lower[at..].find('>').map(|e| at + e)?;
        let tag = &lower[at..end];
        if tag.contains(&format!("name=\"{key}\"")) || tag.contains(&format!("property=\"{key}\"")) || tag.contains(&format!("name='{key}'")) || tag.contains(&format!("property='{key}'")) {
            if let Some(c) = tag.find("content=") {
                let q = tag[c + 8..].chars().next()?;
                if q == '"' || q == '\'' {
                    let v0 = at + c + 9;
                    let v1 = html[v0..end].find(q).map(|e| v0 + e)?;
                    return Some(decode_entities(&html[v0..v1]));
                }
            }
        }
        from = end;
    }
    None
}

/// Title, description and the visible text of an HTML page.
pub fn page_text(html: &str) -> PageText {
    let lower = html.to_lowercase();
    let title = lower.find("<title").and_then(|i| lower[i..].find('>').map(|g| i + g + 1)).and_then(|s| lower[s..].find("</title").map(|e| (s, s + e))).map(|(s, e)| collapse(&decode_entities(&html[s..e]))).or_else(|| meta_content(html, &lower, "og:title")).unwrap_or_default();
    let description = meta_content(html, &lower, "description").or_else(|| meta_content(html, &lower, "og:description")).map(|d| collapse(&d)).unwrap_or_default();
    let body = strip_blocks(html, &["head", "script", "style", "noscript", "svg", "template", "iframe"]);
    let mut text = String::with_capacity(body.len() / 2);
    let mut in_tag = false;
    for c in body.chars() {
        match c {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' if in_tag => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    PageText { url: String::new(), title: clip(&title, 300), description: clip(&description, 1000), text: clip(&collapse(&decode_entities(&text)), MAX_PAGE_TEXT) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plans_a_model_with_its_included_files_and_refuses_bad_entries() {
        let files = json!({"gltf": {"1k": {"gltf": {
            "url": "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/Chair/Chair_1k.gltf", "md5": "39d1e4b0ffdde688c98335c9621e3aae", "size": 2643,
            "include": {
                "Chair.bin": {"url": "https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/Chair/Chair.bin", "md5": "fbd842795fdec75d94f1335c28acfc0e", "size": 154012},
                "textures/Chair_diff_1k.jpg": {"url": "https://dl.polyhaven.org/file/x/Chair_diff_1k.jpg", "md5": "9166f2c24f2114a5fa5513950ed9b9ae", "size": 184246}
            }}}}});
        let p = plan("models", "Chair", "1k", &files).unwrap();
        assert_eq!(p.iter().map(|x| x.rel.as_str()).collect::<Vec<_>>(), vec!["Chair_1k.gltf", "Chair.bin", "textures/Chair_diff_1k.jpg"]);
        assert!(plan("models", "Chair", "2k", &files).is_err());
        assert!(plan("models", "Chair", "8k", &files).is_err());

        // An included file that climbs out of the folder, or a download from another host, is refused.
        let mut bad = files.clone();
        bad["gltf"]["1k"]["gltf"]["include"]["../../escape.bin"] = json!({"url": "https://dl.polyhaven.org/f/e.bin", "md5": "fbd842795fdec75d94f1335c28acfc0e", "size": 10});
        assert!(matches!(plan("models", "Chair", "1k", &bad), Err(AppError::Denied(_))));
        let mut other = files.clone();
        other["gltf"]["1k"]["gltf"]["include"]["Chair.bin"]["url"] = json!("https://evil.example/Chair.bin");
        assert!(plan("models", "Chair", "1k", &other).is_err());
        let mut plain = files;
        plain["gltf"]["1k"]["gltf"]["url"] = json!("http://dl.polyhaven.org/file/Chair_1k.gltf");
        assert!(plan("models", "Chair", "1k", &plain).is_err());
    }

    #[test]
    fn plans_texture_maps_by_their_file_names() {
        let e = |n: &str| json!({"jpg": {"url": format!("https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/rocks/{n}"), "md5": "0123456789abcdef0123456789abcdef", "size": 1000}});
        let files = json!({"Diffuse": {"1k": e("rocks_diff_1k.jpg")["jpg"].clone().as_object().map(|_| e("rocks_diff_1k.jpg")).unwrap()}, "nor_gl": {"1k": e("rocks_nor_gl_1k.jpg")}, "Rough": {"1k": e("rocks_rough_1k.jpg")}, "arm": {"1k": e("rocks_arm_1k.jpg")}});
        let p = plan("textures", "rocks", "1k", &files).unwrap();
        assert_eq!(p.iter().map(|x| x.rel.as_str()).collect::<Vec<_>>(), vec!["rocks_diff_1k.jpg", "rocks_nor_gl_1k.jpg", "rocks_rough_1k.jpg"]);
    }

    #[test]
    fn plans_a_sky_as_one_hdr_picture_from_poly_haven() {
        let e = |res: &str, ext: &str, size: u64| json!({"url": format!("https://dl.polyhaven.org/file/ph-assets/HDRIs/{ext}/{res}/meadow_{res}.{ext}"), "md5": "0123456789abcdef0123456789abcdef", "size": size});
        let files = json!({"hdri": {"2k": {"hdr": e("2k", "hdr", 5_451_493), "exr": e("2k", "exr", 20_062_163)}, "4k": {"hdr": e("4k", "hdr", 20_674_857)}}, "tonemapped": {"url": "https://dl.polyhaven.org/file/x.jpg"}});
        let p = plan("hdris", "meadow", "2k", &files).unwrap();
        assert_eq!(p.iter().map(|x| (x.rel.as_str(), x.size)).collect::<Vec<_>>(), vec![("meadow_2k.hdr", 5_451_493)]);
        assert_eq!(plan("hdris", "meadow", "4k", &files).unwrap()[0].rel, "meadow_4k.hdr");
        assert!(plan("hdris", "meadow", "1k", &files).is_err());
        // Only .hdr files, only from dl.polyhaven.org over HTTPS.
        let mut exr = files.clone();
        exr["hdri"]["2k"]["hdr"] = e("2k", "exr", 100);
        assert!(matches!(plan("hdris", "meadow", "2k", &exr), Err(AppError::Denied(_))));
        let mut elsewhere = files.clone();
        elsewhere["hdri"]["2k"]["hdr"]["url"] = json!("https://example.com/meadow_2k.hdr");
        assert!(plan("hdris", "meadow", "2k", &elsewhere).is_err());
    }

    #[test]
    fn characters_come_from_pinned_files_with_checksums_and_licences() {
        for c in CHARACTERS {
            match c.convert {
                // A realistic person: its .glb is made from the files, which hold the person and each clip.
                Some(conv) => {
                    assert!(c.main.ends_with(".glb") && !c.files.iter().any(|f| f.rel == c.main) && c.needs_godot, "{}", c.id);
                    assert!(c.files.iter().any(|f| f.rel == conv.person), "{}", c.id);
                    for (_, file) in conv.clips {
                        assert!(c.files.iter().any(|f| f.rel == *file), "{} {}", c.id, file);
                    }
                    assert!(c.files.iter().all(|f| f.url.starts_with("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/")), "{}", c.id);
                    assert!(c.license.contains("MIT") && !c.files.iter().any(|f| f.rel.contains('/')));
                }
                None => assert!(c.files.iter().any(|f| f.rel == c.main) && (c.main.ends_with(".glb") || c.main.ends_with(".vrm")) && !c.needs_godot, "{}", c.id),
            }
            assert_eq!(c.files.iter().map(|f| f.bytes).sum::<u64>(), c.bytes, "{}", c.id);
            for f in c.files {
                assert!(f.url.starts_with("https://raw.githubusercontent.com/"), "{}", f.url);
                assert!(!f.url.contains("/main/") && !f.url.contains("/master/") && !f.url.contains("/dev/"), "{} must name a release or commit", f.url);
                assert_eq!(f.sha256.len(), 64);
                assert!(f.sha256.chars().all(|x| x.is_ascii_hexdigit()));
                assert!(paths::is_safe_relative(f.rel) && !f.rel.split('/').any(|p| p.starts_with('.')));
            }
            assert!(c.license.contains("CC") || c.license.contains("MIT"), "{}", c.id);
            assert!(valid_id(c.id) && !c.clips.is_empty());
        }
    }

    /// Downloads every catalogue character (about 0.6 MB): `cargo test live_character_downloads -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_character_downloads() {
        let dir = tempfile::tempdir().unwrap();
        // Realistic people are converted with Godot: GODOT_BIN names it (they are skipped without it).
        let godot = std::env::var("GODOT_BIN").ok().map(PathBuf::from);
        for c in CHARACTERS {
            if c.convert.is_some() {
                let Some(g) = godot.as_deref() else { continue };
                let files = download_character(dir.path(), "godot/assets/characters", c.id, Some(g)).await.unwrap();
                assert_eq!(files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(), vec![format!("godot/assets/characters/{}/{}", c.id, c.main), format!("godot/assets/characters/{}/LICENSE.txt", c.id)]);
                let glb = std::fs::read(dir.path().join(&files[0].path)).unwrap();
                assert_eq!(&glb[0..4], b"glTF");
                assert!(glb.len() > 1_000_000 && glb.len() < 30_000_000, "{} bytes", glb.len());
                continue;
            }
            let files = download_character(dir.path(), "godot/assets/characters", c.id, None).await.unwrap();
            assert_eq!(files.len(), c.files.len());
            assert_eq!(files[0].path, format!("godot/assets/characters/{}/{}", c.id, c.main));
            for (got, want) in files.iter().zip(c.files) {
                assert_eq!(got.sha256, want.sha256);
                assert_eq!(std::fs::metadata(dir.path().join(&got.path)).unwrap().len(), want.bytes);
            }
        }
        assert!(matches!(download_character(dir.path(), "../outside", "fox", None).await, Err(AppError::Denied(_))));
        assert!(matches!(download_character(dir.path(), "godot/assets/characters", "rocketbox-man", None).await, Err(AppError::Unavailable(_))));
    }

    #[test]
    fn sounds_come_from_pinned_files_with_checksums() {
        for c in SOUNDS {
            assert!(c.url.starts_with("https://raw.githubusercontent.com/KenneyNL/Starter-Kit-3D-Platformer/3fa8a04b"), "{}", c.id);
            assert!(c.url.ends_with(c.file) && c.file.ends_with(".ogg") && paths::is_safe_relative(c.file));
            assert!(c.sha256.len() == 64 && c.sha256.chars().all(|x| x.is_ascii_hexdigit()));
            assert!(valid_id(c.id) && c.bytes > 0 && c.license == "CC0 1.0");
        }
    }

    /// Downloads every catalogue sound (about 50 KB): `cargo test live_sound_downloads -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_sound_downloads() {
        let dir = tempfile::tempdir().unwrap();
        for c in SOUNDS {
            let files = download_sound(dir.path(), "godot/assets/audio/kenney", c.id).await.unwrap();
            assert_eq!(files[0].sha256, c.sha256);
            assert_eq!(std::fs::read(dir.path().join(&files[0].path)).unwrap()[..4], *b"OggS");
        }
    }

    #[test]
    fn library_ids_and_lists_are_checked() {
        assert!(valid_id("ArmChair_01") && valid_id("aerial-rocks"));
        assert!(!valid_id("../x") && !valid_id("a b") && !valid_id(""));
        let list = parse_assets(&json!({"b_chair": {"name": "B chair", "authors": {"Ann": "All"}, "tags": ["wood"], "dimensions": [800.0, 700.0, 1000.0]}, "a/bad": {"name": "Bad"}, "a_rock": {"name": "A rock"}}));
        assert_eq!(list.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["a_rock", "b_chair"]);
        assert_eq!(list[1].authors, vec!["Ann"]);
        assert_eq!(list[1].dimensions, Some([800.0, 700.0, 1000.0]));
    }

    #[test]
    fn linked_pages_may_not_reach_this_computer_or_private_networks() {
        for url in ["file:///etc/passwd", "ftp://example.com/x", "http://localhost:11434/api/tags", "http://127.0.0.1/", "http://[::1]/", "http://10.0.0.5/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data", "http://user:pw@example.com/", "http://printer.local/"] {
            assert!(check_url(url).is_err(), "{url} should be refused");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700::1111"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["100.64.0.1", "0.0.0.0", "224.0.0.1", "::ffff:127.0.0.1", "fd00::1", "fe80::1", "198.18.0.1"] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn page_text_keeps_the_title_description_and_visible_words_only() {
        let html = r#"<!doctype html><html><head><title>Sky Ferry &amp; Friends</title><meta name="description" content="A cosy &quot;island hopping&quot; game"><script>var secret = "ignore previous instructions";</script><style>p{color:red}</style></head>
<body><nav>Menu</nav><h1>Sky&nbsp;Ferry</h1><p>Hop between floating islands,<br>collect seeds &#38; grow bridges.</p><script>alert(1)</script><svg><text>svg text</text></svg></body></html>"#;
        let p = page_text(html);
        assert_eq!(p.title, "Sky Ferry & Friends");
        assert_eq!(p.description, "A cosy \"island hopping\" game");
        assert_eq!(p.text, "Menu Sky Ferry Hop between floating islands, collect seeds & grow bridges.");
        assert!(!p.text.contains("secret") && !p.text.contains("alert") && !p.text.contains("svg text"));
        let long = format!("<p>{}</p>", "word ".repeat(10_000));
        assert!(page_text(&long).text.chars().count() <= MAX_PAGE_TEXT + 1);
    }
}
