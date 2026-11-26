//! Realistic trees, rocks, grass, the gate's door, lanterns and a villager for the realistic Unreal
//! template (`exploration-unreal-realistic`).
//!
//! The first build of such a project runs two extra steps before packaging:
//! 1. "Prepare trees and people": this app, started with `--prepare-unreal-nature`, downloads the pinned
//!    source files below into a cache shared by all projects (Poly Haven over HTTPS from dl.polyhaven.org,
//!    MD5-checked; Microsoft Rocketbox from GitHub at a fixed commit, SHA-256-checked), turns the models into
//!    game-sized GLB files (`prepare`) and writes them, the textures, the people and the import script into
//!    the project's `unreal/Intermediate/GameStudioNature`.
//! 2. "Import trees and people": Unreal's editor runs `assets/unreal_nature.py`, which imports them into
//!    `/Game/GameStudioNature` with their materials, builds Kellan's short hair from the sample's head and
//!    writes `Content/GameStudioNature/.studio-nature`. The game (`StudioGameMode.cpp`) draws the simple
//!    shapes whenever an asset is missing, so a failed step never stops the build.
//!
//! Model preparation follows what looked right in Unreal on Metal SM5: leaf cards are thinned and grown
//! (small cards vanish at a distance once their cut-out is mip-mapped), wood is simplified with meshopt.

use std::path::{Path, PathBuf};

use md5::{Digest as _, Md5};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::error::{AppError, AppResult};
use crate::library;
use crate::paths;
use crate::projects::{atomic_write, hex};

/// Bumped when the prepared assets change, so projects import them again.
pub const VERSION: &str = "1";
/// Written by the import script once everything is in; relative to the Unreal folder.
pub const MARKER: &str = "Content/GameStudioNature/.studio-nature";
/// Where step 1 leaves its files for step 2; relative to the Unreal folder (Unreal's own scratch space).
pub const WORK: &str = "Intermediate/GameStudioNature";
pub const SCRIPT: &str = include_str!("../assets/unreal_nature.py");
pub const CLI_FLAG: &str = "--prepare-unreal-nature";

pub enum Check {
    Md5(&'static str),
    Sha256(&'static str),
}

pub struct Source {
    pub rel: &'static str,
    pub url: &'static str,
    pub check: Check,
    pub bytes: u64,
}

const ROCKETBOX_COMMIT: &str = "https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/";

fn allowed_url(url: &str) -> bool {
    url.starts_with("https://dl.polyhaven.org/") || url.starts_with(ROCKETBOX_COMMIT)
}

fn sources() -> impl Iterator<Item = &'static Source> {
    POLY_HAVEN.iter().chain(ROCKETBOX.iter())
}

fn matches(s: &Source, bytes: &[u8]) -> bool {
    bytes.len() as u64 == s.bytes
        && match s.check {
            Check::Md5(m) => hex(&Md5::digest(bytes)) == m,
            Check::Sha256(h) => hex(&Sha256::digest(bytes)) == h,
        }
}

/// A realistic project that has not imported this version of the assets yet.
pub fn needed(unreal: &Path) -> bool {
    let realistic = std::fs::read_to_string(unreal.join("Config/DefaultGame.ini")).map(|t| t.lines().any(|l| l.trim() == "bRealisticLight=True")).unwrap_or(false);
    realistic && std::fs::read_to_string(unreal.join(MARKER)).map(|t| t.trim() != VERSION).unwrap_or(true)
}

/// Downloads what the cache lacks (or holds damaged), checking every file before keeping it.
pub async fn fetch(cache: &Path, log: &mut dyn FnMut(&str)) -> AppResult<()> {
    let http = library::client(900)?;
    let total: u64 = sources().map(|s| s.bytes).sum();
    let mut done = 0u64;
    for s in sources() {
        if !allowed_url(s.url) || !paths::is_safe_relative(s.rel) {
            return Err(AppError::Denied(format!("{} is not an allowed download", s.rel)));
        }
        let path = cache.join(s.rel);
        done += s.bytes;
        if std::fs::read(&path).map(|b| matches(s, &b)).unwrap_or(false) {
            continue;
        }
        log(&format!("downloading {} ({:.1} MB; {:.0} of {:.0} MB)", s.rel, s.bytes as f64 / 1e6, done as f64 / 1e6, total as f64 / 1e6));
        let resp = http.get(s.url).send().await.map_err(library::net_err(if s.url.contains("polyhaven") { "Poly Haven" } else { "GitHub" }))?;
        if !resp.status().is_success() {
            return Err(AppError::Unavailable(format!("{} answered {}", s.rel, resp.status())));
        }
        let bytes = library::read_limited(resp, s.bytes as usize + 1).await?;
        if !matches(s, &bytes) {
            return Err(AppError::Invalid(format!("{} did not match its checksum; nothing was kept", s.rel)));
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        atomic_write(&path, &bytes)?;
    }
    Ok(())
}

// ---- Models ---------------------------------------------------------------------------------

/// One material's triangles.
#[derive(Clone, Default, Debug)]
pub struct Part {
    pub material: String,
    pub pos: Vec<[f32; 3]>,
    pub nrm: Vec<[f32; 3]>,
    pub uv: Vec<[f32; 2]>,
    pub idx: Vec<u32>,
}

impl Part {
    fn append(&mut self, other: &Part) {
        let base = self.pos.len() as u32;
        self.pos.extend_from_slice(&other.pos);
        self.nrm.extend_from_slice(&other.nrm);
        self.uv.extend_from_slice(&other.uv);
        self.idx.extend(other.idx.iter().map(|i| i + base));
    }
    pub fn triangles(&self) -> usize {
        self.idx.len() / 3
    }
    /// Drops vertices no triangle uses.
    fn compact(&mut self) {
        let mut map = vec![u32::MAX; self.pos.len()];
        let (mut pos, mut nrm, mut uv) = (Vec::new(), Vec::new(), Vec::new());
        for i in self.idx.iter_mut() {
            let v = *i as usize;
            if map[v] == u32::MAX {
                map[v] = pos.len() as u32;
                pos.push(self.pos[v]);
                nrm.push(self.nrm[v]);
                uv.push(self.uv[v]);
            }
            *i = map[v];
        }
        (self.pos, self.nrm, self.uv) = (pos, nrm, uv);
    }
}

/// A small, seeded generator, so a model comes out the same on every computer.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
}

type Mat = [[f32; 4]; 4];

fn mul(a: &Mat, b: &Mat) -> Mat {
    let mut m = [[0.0; 4]; 4];
    for (r, row) in m.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = (0..4).map(|k| a[r][k] * b[k][c]).sum();
        }
    }
    m
}

/// A node's transform as a row-major matrix acting on column vectors.
fn node_matrix(node: &Value) -> Mat {
    let f = |k: &str, n: usize, d: f32| -> Vec<f32> { node.get(k).and_then(|v| v.as_array()).filter(|a| a.len() == n).map(|a| a.iter().map(|x| x.as_f64().unwrap_or(d as f64) as f32).collect()).unwrap_or(vec![d; n]) };
    if let Some(m) = node.get("matrix").and_then(|v| v.as_array()).filter(|a| a.len() == 16) {
        let v: Vec<f32> = m.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
        // glTF stores matrices column by column.
        return [[v[0], v[4], v[8], v[12]], [v[1], v[5], v[9], v[13]], [v[2], v[6], v[10], v[14]], [v[3], v[7], v[11], v[15]]];
    }
    let t = f("translation", 3, 0.0);
    let s = f("scale", 3, 1.0);
    let q = node.get("rotation").and_then(|v| v.as_array()).filter(|a| a.len() == 4).map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect::<Vec<_>>()).unwrap_or(vec![0.0, 0.0, 0.0, 1.0]);
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    let r = [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ];
    [
        [r[0][0] * s[0], r[0][1] * s[1], r[0][2] * s[2], t[0]],
        [r[1][0] * s[0], r[1][1] * s[1], r[1][2] * s[2], t[1]],
        [r[2][0] * s[0], r[2][1] * s[1], r[2][2] * s[2], t[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

struct Gltf {
    json: Value,
    buffers: Vec<Vec<u8>>,
}

impl Gltf {
    fn open(path: &Path) -> AppResult<Gltf> {
        let json: Value = serde_json::from_slice(&std::fs::read(path)?).map_err(|e| AppError::Invalid(format!("{}: {e}", path.display())))?;
        let dir = path.parent().unwrap_or(Path::new("."));
        let mut buffers = Vec::new();
        for b in json["buffers"].as_array().cloned().unwrap_or_default() {
            let uri = b["uri"].as_str().ok_or_else(|| AppError::Invalid("A glTF buffer has no file".into()))?;
            if !paths::is_safe_relative(uri) {
                return Err(AppError::Denied(format!("'{uri}' is not an allowed buffer file")));
            }
            buffers.push(std::fs::read(dir.join(uri))?);
        }
        Ok(Gltf { json, buffers })
    }

    /// An accessor's values as f32 rows of `width` (floats only), or as indices (integers).
    fn read(&self, index: u64, width: usize) -> AppResult<Vec<f32>> {
        let bad = || AppError::Invalid(format!("glTF accessor {index} cannot be read"));
        let a = &self.json["accessors"][index as usize];
        let view = &self.json["bufferViews"][a["bufferView"].as_u64().ok_or_else(bad)? as usize];
        let buffer = self.buffers.get(view["buffer"].as_u64().unwrap_or(0) as usize).ok_or_else(bad)?;
        let count = a["count"].as_u64().ok_or_else(bad)? as usize;
        let kind = a["componentType"].as_u64().ok_or_else(bad)?;
        let size = match kind {
            5126 | 5125 => 4,
            5123 | 5122 => 2,
            5121 | 5120 => 1,
            _ => return Err(bad()),
        };
        let start = view["byteOffset"].as_u64().unwrap_or(0) as usize + a["byteOffset"].as_u64().unwrap_or(0) as usize;
        let stride = view["byteStride"].as_u64().map(|s| s as usize).unwrap_or(size * width);
        let mut out = Vec::with_capacity(count * width);
        for i in 0..count {
            for k in 0..width {
                let at = start + i * stride + k * size;
                let b = buffer.get(at..at + size).ok_or_else(bad)?;
                out.push(match kind {
                    5126 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                    5125 => u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32,
                    5123 => u16::from_le_bytes([b[0], b[1]]) as f32,
                    5121 => b[0] as f32,
                    _ => return Err(bad()),
                });
            }
        }
        Ok(out)
    }

    fn indices(&self, index: u64) -> AppResult<Vec<u32>> {
        let a = &self.json["accessors"][index as usize];
        if a["componentType"].as_u64() == Some(5125) {
            // Read u32 exactly (f32 loses precision above 2^24).
            let view = &self.json["bufferViews"][a["bufferView"].as_u64().unwrap_or(0) as usize];
            let buffer = &self.buffers[view["buffer"].as_u64().unwrap_or(0) as usize];
            let start = view["byteOffset"].as_u64().unwrap_or(0) as usize + a["byteOffset"].as_u64().unwrap_or(0) as usize;
            let count = a["count"].as_u64().unwrap_or(0) as usize;
            let bytes = buffer.get(start..start + count * 4).ok_or_else(|| AppError::Invalid("glTF indices cannot be read".into()))?;
            return Ok(bytes.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect());
        }
        Ok(self.read(index, 1)?.into_iter().map(|v| v as u32).collect())
    }

    /// Every mesh node (with its name) as parts in model space, one per material.
    fn nodes(&self) -> AppResult<Vec<(String, Vec<Part>)>> {
        let mut out = Vec::new();
        let scene = self.json["scene"].as_u64().unwrap_or(0) as usize;
        let roots: Vec<u64> = self.json["scenes"][scene]["nodes"].as_array().map(|a| a.iter().filter_map(|v| v.as_u64()).collect()).unwrap_or_default();
        let identity = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]];
        let mut stack: Vec<(u64, Mat, usize)> = roots.into_iter().map(|n| (n, identity, 0)).collect();
        while let Some((n, parent, depth)) = stack.pop() {
            let node = &self.json["nodes"][n as usize];
            if depth > 32 {
                return Err(AppError::Invalid("glTF nodes nest too deeply".into()));
            }
            let m = mul(&parent, &node_matrix(node));
            for c in node["children"].as_array().cloned().unwrap_or_default() {
                if let Some(c) = c.as_u64() {
                    stack.push((c, m, depth + 1));
                }
            }
            let Some(mesh) = node["mesh"].as_u64() else { continue };
            let mut parts: Vec<Part> = Vec::new();
            for p in self.json["meshes"][mesh as usize]["primitives"].as_array().cloned().unwrap_or_default() {
                if p["mode"].as_u64().unwrap_or(4) != 4 {
                    continue;
                }
                let material = p["material"].as_u64().and_then(|i| self.json["materials"][i as usize]["name"].as_str()).unwrap_or("material").to_string();
                let attr = |k: &str| p["attributes"][k].as_u64().ok_or_else(|| AppError::Invalid(format!("A glTF primitive has no {k}")));
                let pos = self.read(attr("POSITION")?, 3)?;
                let nrm = self.read(attr("NORMAL")?, 3)?;
                let uv = self.read(attr("TEXCOORD_0")?, 2)?;
                let idx = match p["indices"].as_u64() {
                    Some(i) => self.indices(i)?,
                    None => (0..(pos.len() / 3) as u32).collect(),
                };
                let mut part = Part { material: material.clone(), ..Default::default() };
                for v in pos.chunks_exact(3) {
                    part.pos.push([0, 1, 2].map(|r| m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2] + m[r][3]));
                }
                for v in nrm.chunks_exact(3) {
                    let n = [0, 1, 2].map(|r| m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);
                    let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-12);
                    part.nrm.push(n.map(|x| x / l));
                }
                part.uv = uv.chunks_exact(2).map(|v| [v[0], v[1]]).collect();
                if part.nrm.len() != part.pos.len() || part.uv.len() != part.pos.len() || idx.iter().any(|&i| i as usize >= part.pos.len()) {
                    return Err(AppError::Invalid("A glTF primitive's attributes do not line up".into()));
                }
                part.idx = idx;
                match parts.iter_mut().find(|q| q.material == material) {
                    Some(q) => q.append(&part),
                    None => parts.push(part),
                }
            }
            out.push((node["name"].as_str().unwrap_or("").to_string(), parts));
        }
        Ok(out)
    }
}

/// Every node whose name contains `pick` (all when empty), merged by material.
fn load(path: &Path, pick: &str) -> AppResult<Vec<Part>> {
    let mut parts: Vec<Part> = Vec::new();
    for (name, ps) in Gltf::open(path)?.nodes()? {
        if !name.contains(pick) {
            continue;
        }
        for p in ps {
            match parts.iter_mut().find(|q| q.material == p.material) {
                Some(q) => q.append(&p),
                None => parts.push(p),
            }
        }
    }
    if parts.is_empty() {
        return Err(AppError::Invalid(format!("{} has no part named like '{pick}'", path.display())));
    }
    Ok(parts)
}

/// Each vertex's island (the triangles connected to it), as the smallest vertex index in it.
pub fn islands(vertices: usize, idx: &[u32]) -> Vec<u32> {
    let mut up: Vec<u32> = (0..vertices as u32).collect();
    fn root(up: &mut [u32], mut v: u32) -> u32 {
        while up[v as usize] != v {
            up[v as usize] = up[up[v as usize] as usize];
            v = up[v as usize];
        }
        v
    }
    for t in idx.chunks_exact(3) {
        for k in 1..3 {
            let (a, b) = (root(&mut up, t[0]), root(&mut up, t[k]));
            if a != b {
                let (lo, hi) = if a < b { (a, b) } else { (b, a) };
                up[hi as usize] = lo;
            }
        }
    }
    (0..vertices as u32).map(|v| root(&mut up, v)).collect()
}

/// Keeps about `keep` of the part's islands and grows each kept one about its middle.
pub fn thin(part: &mut Part, keep: f64, grow: f32, rng: &mut Rng) {
    let label = islands(part.pos.len(), &part.idx);
    let mut kept = std::collections::HashMap::new();
    let mut centre: std::collections::HashMap<u32, ([f64; 3], f64)> = std::collections::HashMap::new();
    let mut idx = Vec::with_capacity(part.idx.len());
    for t in part.idx.chunks_exact(3) {
        let l = label[t[0] as usize];
        if !*kept.entry(l).or_insert_with(|| rng.next() < keep) {
            continue;
        }
        idx.extend_from_slice(t);
        let c = centre.entry(l).or_insert(([0.0; 3], 0.0));
        for &v in t {
            for k in 0..3 {
                c.0[k] += part.pos[v as usize][k] as f64 / 3.0;
            }
        }
        c.1 += 1.0;
    }
    part.idx = idx;
    if grow != 1.0 {
        for (v, p) in part.pos.iter_mut().enumerate() {
            if let Some((sum, n)) = centre.get(&label[v]) {
                for k in 0..3 {
                    let m = (sum[k] / n) as f32;
                    p[k] = m + (p[k] - m) * grow;
                }
            }
        }
    }
    part.compact();
}

/// Simplifies a part to about `ratio` of its triangles (meshoptimizer).
pub fn simplify(part: &mut Part, ratio: f64) -> AppResult<()> {
    let bytes: Vec<u8> = part.pos.iter().flat_map(|p| p.iter().flat_map(|x| x.to_le_bytes())).collect();
    let adapter = meshopt::VertexDataAdapter::new(&bytes, 12, 0).map_err(|e| AppError::Internal(format!("meshopt: {e}")))?;
    let target = ((part.idx.len() / 3) as f64 * ratio) as usize * 3;
    part.idx = meshopt::simplify(&part.idx, &adapter, target, 0.5, meshopt::SimplifyOptions::Permissive, None);
    part.compact();
    Ok(())
}

/// Puts the model's foot (the middle of its lowest 0.3 m) at the origin; glTF is y-up.
fn stand(parts: &mut [Part]) {
    let low = parts.iter().flat_map(|p| p.pos.iter()).map(|p| p[1]).fold(f32::INFINITY, f32::min);
    let (mut x, mut z, mut n) = (0.0f64, 0.0f64, 0.0f64);
    for p in parts.iter().flat_map(|p| p.pos.iter()).filter(|p| p[1] < low + 0.3) {
        x += p[0] as f64;
        z += p[2] as f64;
        n += 1.0;
    }
    let shift = [(x / n.max(1.0)) as f32, low, (z / n.max(1.0)) as f32];
    for p in parts.iter_mut().flat_map(|p| p.pos.iter_mut()) {
        for k in 0..3 {
            p[k] -= shift[k];
        }
    }
}

pub struct Recipe {
    pub name: &'static str,
    pub source: &'static str,
    pub pick: &'static str,
    /// The material whose cards are thinned and grown ("" for none).
    pub leaf: &'static str,
    pub keep: f64,
    pub grow: f32,
    /// How much of the wood (everything but the leaves) is kept.
    pub ratio: f64,
    pub stand: bool,
}

/// The models the game asks for by name (StudioGameMode.cpp, NatureMesh).
pub const RECIPES: &[Recipe] = &[
    Recipe { name: "TreeRound", source: "jacaranda_tree/jacaranda_tree.gltf", pick: "jacaranda", leaf: "leaves", keep: 0.24, grow: 1.9, ratio: 0.3, stand: true },
    Recipe { name: "TreeRoundFar", source: "jacaranda_tree/jacaranda_tree.gltf", pick: "jacaranda", leaf: "leaves", keep: 0.025, grow: 4.2, ratio: 0.03, stand: true },
    Recipe { name: "TreeBaobab", source: "island_tree_01/island_tree_01.gltf", pick: "island", leaf: "leaves", keep: 0.14, grow: 3.0, ratio: 0.25, stand: true },
    Recipe { name: "TreeTallFar", source: "island_tree_01/island_tree_01.gltf", pick: "island", leaf: "leaves", keep: 0.03, grow: 5.0, ratio: 0.08, stand: true },
    Recipe { name: "Rock", source: "boulder_01/boulder_01.gltf", pick: "boulder", leaf: "", keep: 1.0, grow: 1.0, ratio: 0.4, stand: true },
    Recipe { name: "Fern", source: "fern_02/fern_02.gltf", pick: "_b", leaf: "", keep: 1.0, grow: 1.0, ratio: 1.0, stand: true },
    Recipe { name: "Door", source: "large_castle_door/large_castle_door.gltf", pick: "", leaf: "", keep: 1.0, grow: 1.0, ratio: 1.0, stand: false },
    Recipe { name: "Lantern", source: "Lantern_01/Lantern_01.gltf", pick: "", leaf: "", keep: 1.0, grow: 1.0, ratio: 1.0, stand: false },
];

pub fn model(cache: &Path, r: &Recipe, rng: &mut Rng) -> AppResult<Vec<Part>> {
    let mut parts = load(&cache.join(r.source), r.pick)?;
    if r.stand {
        stand(&mut parts);
    }
    for p in parts.iter_mut() {
        if !r.leaf.is_empty() && p.material.contains(r.leaf) {
            thin(p, r.keep, r.grow, rng);
        } else {
            if p.triangles() > 400_000 {
                thin(p, 0.3, 1.0, rng);
            }
            if r.ratio < 1.0 {
                simplify(p, r.ratio)?;
            }
        }
    }
    Ok(parts)
}

/// One grass clump: 60 random pieces of Poly Haven's Bermuda grass, turned and scattered in a 0.5 m circle.
pub fn grass(cache: &Path, rng: &mut Rng) -> AppResult<Part> {
    let pieces: Vec<Part> = Gltf::open(&cache.join("grass_bermuda_01/grass_bermuda_01.gltf"))?
        .nodes()?
        .into_iter()
        .filter(|(n, _)| ["medium", "single", "flattened"].iter().any(|k| n.contains(k)))
        .filter_map(|(_, mut ps)| {
            let mut p = ps.pop()?;
            let n = p.pos.len().max(1) as f32;
            let (mx, mz) = (p.pos.iter().map(|v| v[0]).sum::<f32>() / n, p.pos.iter().map(|v| v[2]).sum::<f32>() / n);
            for v in p.pos.iter_mut() {
                v[0] -= mx;
                v[2] -= mz;
            }
            Some(p)
        })
        .collect();
    if pieces.is_empty() {
        return Err(AppError::Invalid("The grass model has no pieces".into()));
    }
    let mut clump = Part { material: pieces[0].material.clone(), ..Default::default() };
    for _ in 0..60 {
        let mut p = pieces[(rng.next() * pieces.len() as f64) as usize % pieces.len()].clone();
        let a = (rng.next() * std::f64::consts::TAU) as f32;
        let s = (2.0 + 1.4 * rng.next()) as f32;
        let r = (0.5 * rng.next().sqrt()) as f32;
        let b = (rng.next() * std::f64::consts::TAU) as f32;
        let (sa, ca) = a.sin_cos();
        for v in p.pos.iter_mut() {
            let (x, z) = (v[0] * ca + v[2] * sa, -v[0] * sa + v[2] * ca);
            *v = [x * s + r * b.cos(), v[1] * s, z * s + r * b.sin()];
        }
        for n in p.nrm.iter_mut() {
            *n = [n[0] * ca + n[2] * sa, n[1], -n[0] * sa + n[2] * ca];
        }
        clump.append(&p);
    }
    Ok(clump)
}

/// A binary glTF with one mesh, one primitive per part, materials named after the parts (no textures:
/// the import script makes the materials).
pub fn glb(parts: &[Part]) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let mut views = Vec::new();
    let mut accessors = Vec::new();
    let mut prims = Vec::new();
    let mut push = |bin: &mut Vec<u8>, data: Vec<u8>, target: u64| -> usize {
        while bin.len() % 4 != 0 {
            bin.push(0);
        }
        views.push(json!({"buffer": 0, "byteOffset": bin.len(), "byteLength": data.len(), "target": target}));
        bin.extend_from_slice(&data);
        views.len() - 1
    };
    for (i, p) in parts.iter().enumerate() {
        let f32s = |v: &mut dyn Iterator<Item = f32>| -> Vec<u8> { v.flat_map(|x| x.to_le_bytes()).collect() };
        let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for v in &p.pos {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
        let n = p.pos.len();
        let vp = push(&mut bin, f32s(&mut p.pos.iter().flat_map(|v| *v)), 34962);
        let vn = push(&mut bin, f32s(&mut p.nrm.iter().flat_map(|v| *v)), 34962);
        let vu = push(&mut bin, f32s(&mut p.uv.iter().flat_map(|v| *v)), 34962);
        let vi = push(&mut bin, p.idx.iter().flat_map(|x| x.to_le_bytes()).collect(), 34963);
        let a = accessors.len();
        accessors.push(json!({"bufferView": vp, "componentType": 5126, "count": n, "type": "VEC3", "min": lo, "max": hi}));
        accessors.push(json!({"bufferView": vn, "componentType": 5126, "count": n, "type": "VEC3"}));
        accessors.push(json!({"bufferView": vu, "componentType": 5126, "count": n, "type": "VEC2"}));
        accessors.push(json!({"bufferView": vi, "componentType": 5125, "count": p.idx.len(), "type": "SCALAR"}));
        prims.push(json!({"attributes": {"POSITION": a, "NORMAL": a + 1, "TEXCOORD_0": a + 2}, "indices": a + 3, "material": i}));
    }
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    let doc = json!({
        "asset": {"version": "2.0", "generator": "Game Studio"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "model"}],
        "meshes": [{"primitives": prims}],
        "materials": parts.iter().map(|p| json!({"name": p.material, "doubleSided": true})).collect::<Vec<_>>(),
        "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": bin.len()}],
    });
    let mut text = serde_json::to_vec(&doc).unwrap_or_default();
    while text.len() % 4 != 0 {
        text.push(b' ');
    }
    let mut out = Vec::with_capacity(28 + text.len() + bin.len());
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&((28 + text.len() + bin.len()) as u32).to_le_bytes());
    out.extend_from_slice(&(text.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&text);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);
    out
}

const CREDITS: &str = "Realistic nature and people added by Game Studio.\n\n\
Poly Haven (https://polyhaven.com), CC0 (public domain): Jacaranda Tree, Island Tree 01, Boulder 01, Fern 02,\n\
Grass Bermuda 01, Large Castle Door, Lantern 01, and the Leafy Grass, Sparse Grass, Castle Wall Slates and\n\
Weathered Planks textures.\n\n";

/// Builds everything step 2 needs into `out` (the project's Intermediate/GameStudioNature).
pub fn prepare(cache: &Path, out: &Path, log: &mut dyn FnMut(&str)) -> AppResult<()> {
    if out.exists() {
        std::fs::remove_dir_all(out)?;
    }
    for d in ["glb", "tex", "people"] {
        std::fs::create_dir_all(out.join(d))?;
    }
    let mut rng = Rng::new(7);
    for r in RECIPES {
        let parts = model(cache, r, &mut rng)?;
        let tris: usize = parts.iter().map(|p| p.triangles()).sum();
        let each: Vec<String> = parts.iter().map(|p| format!("{} {}", p.material, p.triangles())).collect();
        log(&format!("prepared {} ({} triangles: {})", r.name, tris, each.join(", ")));
        atomic_write(&out.join("glb").join(format!("{}.glb", r.name)), &glb(&parts))?;
    }
    let clump = grass(cache, &mut rng)?;
    log(&format!("prepared Grass ({} triangles)", clump.triangles()));
    atomic_write(&out.join("glb/Grass.glb"), &glb(&[clump]))?;
    for s in sources() {
        let name = Path::new(s.rel).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let to = if s.rel.starts_with("people/") {
            out.join("people").join(&name)
        } else if name.ends_with(".jpg") {
            out.join("tex").join(&name)
        } else {
            continue;
        };
        std::fs::copy(cache.join(s.rel), to)?;
    }
    atomic_write(&out.join("unreal_nature.py"), SCRIPT.as_bytes())?;
    atomic_write(&out.join("CREDITS.txt"), format!("{CREDITS}{}", library::ROCKETBOX_LICENSE).as_bytes())?;
    atomic_write(&out.join("version.txt"), VERSION.as_bytes())?;
    Ok(())
}

/// `game-studio --prepare-unreal-nature <unreal folder> <cache folder>`, run as a build step. It never fails
/// the build: without the assets the game draws its simple shapes, so problems are reported and skipped.
pub fn run_cli(args: &[String]) -> i32 {
    let (Some(unreal), Some(cache)) = (args.first().map(PathBuf::from), args.get(1).map(PathBuf::from)) else {
        eprintln!("usage: {CLI_FLAG} <unreal folder> <cache folder>");
        return 2;
    };
    let out = unreal.join(WORK);
    let mut log = |m: &str| println!("nature: {m}");
    let result = (|| -> AppResult<()> {
        if !unreal.join("Config").is_dir() {
            return Err(AppError::NotFound(format!("{} is not an Unreal project folder", unreal.display())));
        }
        std::fs::create_dir_all(&cache)?;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| AppError::Internal(e.to_string()))?;
        rt.block_on(fetch(&cache, &mut log))?;
        prepare(&cache, &out, &mut log)
    })();
    match result {
        Ok(()) => log("ready to import"),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&out);
            log(&format!("not added ({e}); the game keeps its simple shapes"));
        }
    }
    0
}
/// Poly Haven files (CC0), pinned by URL and MD5 as the API listed them on 2026-11-26.
pub const POLY_HAVEN: &[Source] = &[
    Source { rel: "jacaranda_tree/jacaranda_tree.gltf", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/jacaranda_tree/jacaranda_tree_1k.gltf", check: Check::Md5("8fed93ff7cbdaac0f5c199ef1fd0f694"), bytes: 9_526 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_branches_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_branches_nor_gl_1k.jpg", check: Check::Md5("789084affb01f4a22290a848558f5e12"), bytes: 819_101 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_branches_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_branches_diff_1k.jpg", check: Check::Md5("e5bacbfd3e7ce397bdd34b0bac6669ca"), bytes: 531_544 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_branches_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_branches_arm_1k.jpg", check: Check::Md5("5b6f5b3838f4a8f60fea14fa3a3fef9f"), bytes: 484_806 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_trunk_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_trunk_nor_gl_1k.jpg", check: Check::Md5("af34d3a054b498f153e4793f7520a630"), bytes: 1_096_100 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_trunk_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_trunk_diff_1k.jpg", check: Check::Md5("c3edc2e76157023e7a5c35cd13867498"), bytes: 896_938 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_trunk_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_trunk_arm_1k.jpg", check: Check::Md5("7232b4514e9412725a6a8e65a69f4ed4"), bytes: 895_975 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_leaves_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_leaves_nor_gl_1k.jpg", check: Check::Md5("7cbd82c0dd4b8c8a4ab314338f50404d"), bytes: 700_843 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_leaves_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_leaves_diff_1k.jpg", check: Check::Md5("8ae91737f39567629768a255817d80be"), bytes: 533_896 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_leaves_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_leaves_arm_1k.jpg", check: Check::Md5("fabee050680fd173032acf003ef61191"), bytes: 332_762 },
    Source { rel: "jacaranda_tree/jacaranda_tree.bin", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/8k/jacaranda_tree/jacaranda_tree.bin", check: Check::Md5("ae25eacd5e67ea2e9bbbaa2854b6ed99"), bytes: 208_307_808 },
    Source { rel: "jacaranda_tree/textures/jacaranda_tree_leaves_alpha.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/jacaranda_tree/jacaranda_tree_leaves_alpha_1k.jpg", check: Check::Md5("80da0d21e783a3f81a096bf5139fce47"), bytes: 533_665 },
    Source { rel: "island_tree_01/island_tree_01.gltf", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/island_tree_01/island_tree_01_1k.gltf", check: Check::Md5("fbc0c570ebd71ea88cedc1f9d5edb835"), bytes: 8_576 },
    Source { rel: "island_tree_01/textures/island_tree_01_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_nor_gl_1k.jpg", check: Check::Md5("3871f67863453a16b866950202fa2b7f"), bytes: 1_207_134 },
    Source { rel: "island_tree_01/textures/island_tree_01_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_diff_1k.jpg", check: Check::Md5("8a67489846657df6b859d97e0b80fcf4"), bytes: 791_327 },
    Source { rel: "island_tree_01/textures/island_tree_01_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_arm_1k.jpg", check: Check::Md5("8077da7d1a001867c0da0cde6bc807f2"), bytes: 727_403 },
    Source { rel: "island_tree_01/textures/island_tree_01_leaves_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_leaves_nor_gl_1k.jpg", check: Check::Md5("a08ffb98b5ffb7dfa682e05a1639c642"), bytes: 379_443 },
    Source { rel: "island_tree_01/textures/island_tree_01_leaves_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_leaves_diff_1k.jpg", check: Check::Md5("1356cbb5a5dd1318f9f2a01eddbf03e1"), bytes: 191_886 },
    Source { rel: "island_tree_01/textures/island_tree_01_leaves_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_leaves_arm_1k.jpg", check: Check::Md5("27b06c4a53ff115ed7d51ee94e417257"), bytes: 489_476 },
    Source { rel: "island_tree_01/textures/island_tree_01_branches_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_branches_nor_gl_1k.jpg", check: Check::Md5("789084affb01f4a22290a848558f5e12"), bytes: 819_101 },
    Source { rel: "island_tree_01/textures/island_tree_01_branches_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_branches_diff_1k.jpg", check: Check::Md5("7792907fe2b2b748c129a2384192a579"), bytes: 528_304 },
    Source { rel: "island_tree_01/textures/island_tree_01_branches_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_branches_arm_1k.jpg", check: Check::Md5("5b6f5b3838f4a8f60fea14fa3a3fef9f"), bytes: 484_806 },
    Source { rel: "island_tree_01/island_tree_01.bin", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/8k/island_tree_01/island_tree_01.bin", check: Check::Md5("8271f2d12c2727bd647ce0c242acdcec"), bytes: 60_709_812 },
    Source { rel: "island_tree_01/textures/island_tree_01_leaves_alpha.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_leaves_alpha_1k.jpg", check: Check::Md5("da7ea0a883265115f2c0f5fbc6101f8d"), bytes: 84_228 },
    Source { rel: "boulder_01/boulder_01.gltf", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/boulder_01/boulder_01_1k.gltf", check: Check::Md5("26e2eef4a1f68c9557c65cd375b21d6c"), bytes: 2_773 },
    Source { rel: "boulder_01/textures/boulder_01_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/boulder_01/boulder_01_arm_1k.jpg", check: Check::Md5("d632159982cc3121ed3d69b89a122146"), bytes: 659_386 },
    Source { rel: "boulder_01/textures/boulder_01_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/boulder_01/boulder_01_diff_1k.jpg", check: Check::Md5("25f8a843f13369d56d37f49db05ea8c3"), bytes: 987_467 },
    Source { rel: "boulder_01/boulder_01.bin", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/8k/boulder_01/boulder_01.bin", check: Check::Md5("27a19fa031d8b4c3a09261f19c444dc5"), bytes: 2_938_808 },
    Source { rel: "boulder_01/textures/boulder_01_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/boulder_01/boulder_01_nor_gl_1k.jpg", check: Check::Md5("0c4da644d901144b53e4fe2446f3c389"), bytes: 1_183_552 },
    Source { rel: "fern_02/fern_02.gltf", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/fern_02/fern_02_1k.gltf", check: Check::Md5("cf276874d37bfb73c299504a6b355b77"), bytes: 6_899 },
    Source { rel: "fern_02/textures/fern_02_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/fern_02/fern_02_arm_1k.jpg", check: Check::Md5("1bbb2b22951f450720d28e17d93a2987"), bytes: 280_359 },
    Source { rel: "fern_02/textures/fern_02_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/fern_02/fern_02_diff_1k.jpg", check: Check::Md5("82c18a6cfd5ae91c37c0e078f591181c"), bytes: 315_705 },
    Source { rel: "fern_02/textures/fern_02_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/fern_02/fern_02_nor_gl_1k.jpg", check: Check::Md5("43aed63dff79554f6064627515afd9d7"), bytes: 367_222 },
    Source { rel: "fern_02/fern_02.bin", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/8k/fern_02/fern_02.bin", check: Check::Md5("c061e9255f7d36ae9ce0e92ef3e100b2"), bytes: 176_176 },
    Source { rel: "fern_02/textures/fern_02_alpha.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/fern_02/fern_02_alpha_1k.jpg", check: Check::Md5("f2f725efc89ed87132c8706ca3ad223e"), bytes: 246_038 },
    Source { rel: "grass_bermuda_01/grass_bermuda_01.gltf", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/grass_bermuda_01/grass_bermuda_01_1k.gltf", check: Check::Md5("a1bdd74118d2387a42dba4f605226f87"), bytes: 32_912 },
    Source { rel: "grass_bermuda_01/textures/grass_bermuda_01_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/grass_bermuda_01/grass_bermuda_01_nor_gl_1k.jpg", check: Check::Md5("73a585e0963ff6bf3cefa845cbee0645"), bytes: 709_845 },
    Source { rel: "grass_bermuda_01/textures/grass_bermuda_01_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/grass_bermuda_01/grass_bermuda_01_diff_1k.jpg", check: Check::Md5("234be9f52cfcd3380c7f782baaa841c3"), bytes: 175_425 },
    Source { rel: "grass_bermuda_01/textures/grass_bermuda_01_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/grass_bermuda_01/grass_bermuda_01_arm_1k.jpg", check: Check::Md5("87c58d5d3345d579eab570f7eb446313"), bytes: 500_088 },
    Source { rel: "grass_bermuda_01/grass_bermuda_01.bin", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/8k/grass_bermuda_01/grass_bermuda_01.bin", check: Check::Md5("2940aa3405004b62983fd70bede8e47f"), bytes: 32_260 },
    Source { rel: "grass_bermuda_01/textures/grass_bermuda_01_alpha.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/grass_bermuda_01/grass_bermuda_01_alpha_1k.jpg", check: Check::Md5("6708f6560bc02997fbf936e2eb43b5d9"), bytes: 165_395 },
    Source { rel: "large_castle_door/large_castle_door.gltf", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/large_castle_door/large_castle_door_1k.gltf", check: Check::Md5("40c7debfb0e9f51826b294d642bc0bfe"), bytes: 6_111 },
    Source { rel: "large_castle_door/large_castle_door.bin", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/large_castle_door/large_castle_door.bin", check: Check::Md5("ed0cee2626677b1a520de7bd868d09cc"), bytes: 422_436 },
    Source { rel: "large_castle_door/textures/large_castle_door_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/large_castle_door/large_castle_door_nor_gl_1k.jpg", check: Check::Md5("4a0e452157d95c0d18a2f79429ec471d"), bytes: 1_023_095 },
    Source { rel: "large_castle_door/textures/large_castle_door_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/large_castle_door/large_castle_door_arm_1k.jpg", check: Check::Md5("e742bcceba429ca946edc788dac922ff"), bytes: 1_016_111 },
    Source { rel: "large_castle_door/textures/large_castle_door_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/large_castle_door/large_castle_door_diff_1k.jpg", check: Check::Md5("641c090895f68f3be02f8db278385174"), bytes: 803_253 },
    Source { rel: "Lantern_01/Lantern_01.gltf", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/Lantern_01/Lantern_01_1k.gltf", check: Check::Md5("61fbf9f6e215ab4ff1123d6cbfd337a6"), bytes: 4_866 },
    Source { rel: "Lantern_01/textures/Lantern_01_brass_arm_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/Lantern_01/Lantern_01_brass_arm_1k.jpg", check: Check::Md5("cad411a300663678f546ed8b1c9b97f1"), bytes: 229_054 },
    Source { rel: "Lantern_01/Lantern_01.bin", url: "https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/Lantern_01/Lantern_01.bin", check: Check::Md5("857a868798e7e5f40d78c2d09e6f8ea0"), bytes: 864_852 },
    Source { rel: "Lantern_01/textures/Lantern_01_brass_nor_gl_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/Lantern_01/Lantern_01_brass_nor_gl_1k.jpg", check: Check::Md5("6d6805ac7932d9927f7ec817db77b5d5"), bytes: 180_646 },
    Source { rel: "Lantern_01/textures/Lantern_01_brass_diff_1k.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/Lantern_01/Lantern_01_brass_diff_1k.jpg", check: Check::Md5("e8abf88b7ac60649c54c8d0a639f0713"), bytes: 140_998 },
    Source { rel: "textures/leafy_grass_Diffuse.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_diff_2k.jpg", check: Check::Md5("8014f4dace676a62ed71b3dd76119dae"), bytes: 4_766_204 },
    Source { rel: "textures/leafy_grass_nor_dx.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_nor_dx_2k.jpg", check: Check::Md5("82936efe4dd20543414cb55d47a9f53c"), bytes: 6_049_495 },
    Source { rel: "textures/leafy_grass_Rough.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/leafy_grass/leafy_grass_rough_2k.jpg", check: Check::Md5("b5c551ed91162aab5afbfb03b73ae3f5"), bytes: 2_274_652 },
    Source { rel: "textures/sparse_grass_Diffuse.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sparse_grass/sparse_grass_diff_2k.jpg", check: Check::Md5("b181e9c61bae87c1bb9b14eecd767d65"), bytes: 3_733_797 },
    Source { rel: "textures/sparse_grass_nor_dx.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sparse_grass/sparse_grass_nor_dx_2k.jpg", check: Check::Md5("61bd9f973de0f3322b42184302120873"), bytes: 5_862_886 },
    Source { rel: "textures/sparse_grass_Rough.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/sparse_grass/sparse_grass_rough_2k.jpg", check: Check::Md5("446cbe6254b1b210de44ef7c53da6204"), bytes: 1_729_786 },
    Source { rel: "textures/castle_wall_slates_Diffuse.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/castle_wall_slates/castle_wall_slates_diff_1k.jpg", check: Check::Md5("0f32f47b63c6303ba0d2c79d6672a402"), bytes: 625_282 },
    Source { rel: "textures/castle_wall_slates_nor_dx.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/castle_wall_slates/castle_wall_slates_nor_dx_1k.jpg", check: Check::Md5("21bdf52db8c813e11a8bf22eeee3fe2c"), bytes: 1_095_984 },
    Source { rel: "textures/castle_wall_slates_Rough.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/castle_wall_slates/castle_wall_slates_rough_1k.jpg", check: Check::Md5("d8bf1af4754dea48327002d4ec417925"), bytes: 517_739 },
    Source { rel: "textures/weathered_planks_Diffuse.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/weathered_planks/weathered_planks_diff_1k.jpg", check: Check::Md5("5d7c9e7088bfa54490ba03ba15b660d8"), bytes: 599_581 },
    Source { rel: "textures/weathered_planks_nor_dx.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/weathered_planks/weathered_planks_nor_dx_1k.jpg", check: Check::Md5("2281fa0058edea82b853ea3e969f62ea"), bytes: 679_205 },
    Source { rel: "textures/weathered_planks_Rough.jpg", url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/weathered_planks/weathered_planks_rough_1k.jpg", check: Check::Md5("4ca50b076e1fc58f6862a5b039a7d5c9"), bytes: 218_802 },
];
/// Microsoft Rocketbox (MIT), pinned to the archived repository's last commit, checked by SHA-256.
pub const ROCKETBOX: &[Source] = &[
    Source { rel: "people/Female_Adult_11.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_11/Export/Female_Adult_11.fbx"), check: Check::Sha256("713d79f1bf21e20e9c1e9ec4ed4d421c84c0466dfdeebf59d47af81b71b8ca88"), bytes: 612_192 },
    Source { rel: "people/f011_body_color.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_11/Textures/f011_body_color.tga"), check: Check::Sha256("e9797c77c32009ba0485aa351876063daa0e88250fba4884377faf8cea1d5eb6"), bytes: 12_582_956 },
    Source { rel: "people/f011_body_normal.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_11/Textures/f011_body_normal.tga"), check: Check::Sha256("f767de8eca7b7e0b25cd8d5869398678e4fd2cef9cd764267ec631221922d3e4"), bytes: 12_582_956 },
    Source { rel: "people/f011_head_color.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_11/Textures/f011_head_color.tga"), check: Check::Sha256("f2439ebb800708c467f3cf0147568d3e9c3c61ac76977363fc992d16e8b38efe"), bytes: 12_582_956 },
    Source { rel: "people/f011_head_normal.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_11/Textures/f011_head_normal.tga"), check: Check::Sha256("3271569db6b47df4d388d92cd622ab194a84f222109b4910e5376c72b12d328a"), bytes: 12_582_956 },
    Source { rel: "people/f011_opacity_color.tga", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Avatars/Adults/Female_Adult_11/Textures/f011_opacity_color.tga"), check: Check::Sha256("07d5e246c49b95a15c336e4135d1d9a5cebfe2e3cb68b6041346ddf8c61b12f0"), bytes: 16_777_260 },
    Source { rel: "people/f_idle_neutral_01.max.fbx", url: concat!("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets", "/Animations/all_animations_max_motextr_static/f_idle_neutral_01.max.fbx"), check: Check::Sha256("fd68b33ea9e290dc734ca8c3a71ef5842bb2dfe719853ff84f6336d06d39fdcb"), bytes: 2_959_360 },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_only_pinned_files_from_poly_haven_and_rocketbox_at_a_fixed_commit() {
        let mut seen = std::collections::HashSet::new();
        for s in sources() {
            assert!(allowed_url(s.url), "{}", s.url);
            assert!(paths::is_safe_relative(s.rel), "{}", s.rel);
            assert!(seen.insert(s.rel), "{} twice", s.rel);
            assert!(s.bytes > 0);
            match s.check {
                Check::Md5(m) => assert!(m.len() == 32 && s.url.starts_with("https://dl.polyhaven.org/"), "{}", s.rel),
                Check::Sha256(h) => assert!(h.len() == 64 && s.url.starts_with(ROCKETBOX_COMMIT), "{}", s.rel),
            }
        }
        assert!(!allowed_url("http://dl.polyhaven.org/x") && !allowed_url("https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/main/x"));
        // Every model the recipes read is downloaded, with the textures the import script asks for.
        for r in RECIPES {
            assert!(sources().any(|s| s.rel == r.source), "{}", r.source);
        }
        for t in ["jacaranda_tree_leaves_alpha.jpg", "island_tree_01_leaves_alpha.jpg", "grass_bermuda_01_alpha.jpg", "fern_02_alpha.jpg", "castle_wall_slates_nor_dx.jpg", "large_castle_door_arm_1k.jpg"] {
            assert!(sources().any(|s| s.rel.ends_with(t)), "{t}");
        }
    }

    #[test]
    fn a_file_must_match_its_size_and_checksum() {
        let s = Source { rel: "x", url: "https://dl.polyhaven.org/x", check: Check::Md5("900150983cd24fb0d6963f7d28e17f72"), bytes: 3 };
        assert!(matches(&s, b"abc"));
        assert!(!matches(&s, b"abd"));
        let s = Source { rel: "x", url: ROCKETBOX_COMMIT, check: Check::Sha256("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), bytes: 3 };
        assert!(matches(&s, b"abc") && !matches(&s, b"abcd"));
    }

    /// Two separate squares (islands), each two triangles.
    fn cards() -> Part {
        let mut p = Part { material: "leaves".into(), ..Default::default() };
        for (i, x) in [0.0f32, 10.0].iter().enumerate() {
            p.pos.extend([[*x, 0.0, 0.0], [x + 1.0, 0.0, 0.0], [x + 1.0, 1.0, 0.0], [*x, 1.0, 0.0]]);
            p.nrm.extend([[0.0, 0.0, 1.0]; 4]);
            p.uv.extend([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
            let b = i as u32 * 4;
            p.idx.extend([b, b + 1, b + 2, b, b + 2, b + 3]);
        }
        p
    }

    #[test]
    fn finds_islands_and_grows_the_kept_ones_about_their_middle() {
        let p = cards();
        assert_eq!(islands(p.pos.len(), &p.idx), vec![0, 0, 0, 0, 4, 4, 4, 4]);
        let mut all = cards();
        thin(&mut all, 1.0, 2.0, &mut Rng::new(1));
        assert_eq!(all.triangles(), 4);
        // The first square's middle is (0.5, 0.5); grown twice as big it spans -0.5..1.5.
        let xs: Vec<f32> = all.pos[..4].iter().map(|p| p[0]).collect();
        assert!(xs.iter().any(|x| (x + 0.5).abs() < 1e-5) && xs.iter().any(|x| (x - 1.5).abs() < 1e-5), "{xs:?}");
        let mut none = cards();
        thin(&mut none, 0.0, 1.0, &mut Rng::new(1));
        assert_eq!((none.triangles(), none.pos.len()), (0, 0));
    }

    #[test]
    fn simplifies_a_dense_grid() {
        let mut p = Part { material: "wood".into(), ..Default::default() };
        let n = 40u32;
        for y in 0..=n {
            for x in 0..=n {
                p.pos.push([x as f32, y as f32, 0.0]);
                p.nrm.push([0.0, 0.0, 1.0]);
                p.uv.push([x as f32 / n as f32, y as f32 / n as f32]);
            }
        }
        for y in 0..n {
            for x in 0..n {
                let a = y * (n + 1) + x;
                p.idx.extend([a, a + 1, a + n + 2, a, a + n + 2, a + n + 1]);
            }
        }
        let before = p.triangles();
        simplify(&mut p, 0.1).unwrap();
        assert!(p.triangles() > 0 && p.triangles() <= before / 5, "{} of {before}", p.triangles());
        assert!(p.idx.iter().all(|&i| (i as usize) < p.pos.len()));
    }

    #[test]
    fn the_generator_repeats_and_spreads() {
        let (mut a, mut b) = (Rng::new(7), Rng::new(7));
        let xs: Vec<f64> = (0..1000).map(|_| a.next()).collect();
        assert!(xs.iter().zip((0..1000).map(|_| b.next())).all(|(x, y)| *x == y));
        assert!(xs.iter().all(|x| (0.0..1.0).contains(x)));
        let mean = xs.iter().sum::<f64>() / 1000.0;
        assert!((mean - 0.5).abs() < 0.05, "{mean}");
    }

    #[test]
    fn writes_a_binary_gltf_with_named_materials() {
        let g = glb(&[cards()]);
        assert_eq!(&g[0..4], b"glTF");
        assert_eq!(u32::from_le_bytes([g[8], g[9], g[10], g[11]]) as usize, g.len());
        let len = u32::from_le_bytes([g[12], g[13], g[14], g[15]]) as usize;
        let doc: Value = serde_json::from_slice(&g[20..20 + len]).unwrap();
        assert_eq!(doc["materials"][0]["name"], "leaves");
        assert_eq!(doc["accessors"][0]["count"], 8);
        assert_eq!(doc["accessors"][0]["max"], json!([11.0, 1.0, 0.0]));
        assert_eq!(doc["accessors"][3]["count"], 12);
        assert_eq!(len % 4, 0);
    }

    #[test]
    fn only_realistic_projects_that_lack_this_version_need_the_steps() {
        let dir = tempfile::tempdir().unwrap();
        let unreal = dir.path();
        std::fs::create_dir_all(unreal.join("Config")).unwrap();
        std::fs::write(unreal.join("Config/DefaultGame.ini"), "[/Script/StudioValley.StudioGameMode]\nbRealisticLight=False\n").unwrap();
        assert!(!needed(unreal));
        std::fs::write(unreal.join("Config/DefaultGame.ini"), "[/Script/StudioValley.StudioGameMode]\nbRealisticLight=True\n").unwrap();
        assert!(needed(unreal));
        std::fs::create_dir_all(unreal.join("Content/GameStudioNature")).unwrap();
        std::fs::write(unreal.join(MARKER), "0").unwrap();
        assert!(needed(unreal));
        std::fs::write(unreal.join(MARKER), VERSION).unwrap();
        assert!(!needed(unreal));
    }

    #[test]
    fn the_import_script_names_what_the_game_loads() {
        // StudioGameMode.cpp: NatureMesh, Surface, Person and CoverHair.
        let game = include_str!("../../../../templates/exploration-unreal/unreal/Source/StudioValley/StudioGameMode.cpp");
        for r in RECIPES {
            assert!(game.contains(&format!("TEXT(\"{}\")", r.name)), "the game never asks for {}", r.name);
        }
        for (script, cpp) in [("\"M_Stone\"", "M_Stone"), ("\"M_Wood\"", "M_Wood"), ("M_WomanBody", "M_Woman%s"), ("/People/Kellan", "People/Kellan/HairCap"), ("Female_Adult_11", "Female_Adult_11"), ("M_Ground", "M_Ground")] {
            assert!(SCRIPT.contains(script), "{script}");
            assert!(game.contains(cpp), "{cpp}");
        }
        assert!(SCRIPT.contains(".studio-nature") && MARKER.ends_with(".studio-nature"));
    }
}
