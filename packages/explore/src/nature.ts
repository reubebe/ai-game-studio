import { hash01 } from "./look";

/**
 * Detailed trees and rocks for the realistic style, built from numbers (no model files): bark tubes
 * that branch, two-sided leaf cards showing the leaf picture (leaf_atlas.gd), and rocks with broken
 * faces, dark crevices and moss on top. This is the same code as the game's
 * templates/exploration-3d/godot/scripts/nature.gd, call for call: change the two together (the
 * Godot integration test compares their meshes). Triangles here wind counter-clockwise seen from
 * outside (three.js); nature.gd flips them for Godot. Colours are screen colours (sRGB, 0 to 1): Godot's
 * web renderer treats a material's colour as one and converts it at the end, so nature.gd marks them
 * vertex_color_is_srgb, and the studio's 3D view converts them to linear light itself.
 */

/** How many shapes each kind of tree and the rock come in; an object's id picks one. */
export const NATURE_VARIANTS = 4;

export type NatureKind = "round" | "tall" | "baobab" | "rock";

export interface NatureMesh {
  positions: number[];
  normals: number[];
  colors: number[];
  uvs: number[];
  indices: number[];
}

type V = [number, number, number];

const TAU = Math.PI * 2;
/** Where the leaf picture's halves are: [u, v, width, height]. */
const BROAD: readonly [number, number, number, number] = [0, 0, 0.5, 1];
const NEEDLES: readonly [number, number, number, number] = [0.5, 0, 0.5, 1];
/** Bark colours (screen colours, 0 to 1). */
const BARK_ROUND: V = [0.4, 0.31, 0.23];
const BARK_PINE: V = [0.35, 0.26, 0.2];
const BARK_BAOBAB: V = [0.6, 0.53, 0.47];
const LEAF_ROUND: V = [1, 1, 1];
const LEAF_PINE: V = [0.92, 1, 0.95];
const LEAF_BAOBAB: V = [1.05, 1.08, 0.82];

/** 32-bit FNV-1a of the id's UTF-8 bytes. */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (const b of new TextEncoder().encode(id)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}

/** Which of the NATURE_VARIANTS shapes an object gets. */
export function variantOf(id: string): number {
  return seedOf(id) % NATURE_VARIANTS;
}

/** An object's own turn about its middle, in radians (counter-clockwise seen from above), so neighbours differ. */
export function turnOf(id: string): number {
  return hash01(seedOf(id), 1, 4421) * TAU;
}

function rng(seed: number) {
  let n = 0;
  const next = () => hash01(seed, ++n, 9137);
  return { next, between: (a: number, b: number) => a + (b - a) * next() };
}
type Rng = ReturnType<typeof rng>;

// ---- small maths, written out as nature.gd does it ------------------------------------------

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);
function smoothstep(a: number, b: number, x: number): number {
  const s = clamp((x - a) / (b - a), 0, 1);
  return s * s * (3 - 2 * s);
}
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(a: V): V {
  const l = Math.sqrt(dot(a, a));
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}
const mix = (a: V, b: V, t: number): V => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smooth = (t: number) => t * t * (3 - 2 * t);
const lattice = (i: number, j: number, k: number, s: number) => hash01(i, j, k * 92821 + s);

/** Value noise in 3D, from 0 to 1. */
export function noise3(x: number, y: number, z: number, s: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const ux = smooth(x - fx);
  const uy = smooth(y - fy);
  const uz = smooth(z - fz);
  const a = lerp(lattice(fx, fy, fz, s), lattice(fx + 1, fy, fz, s), ux);
  const b = lerp(lattice(fx, fy + 1, fz, s), lattice(fx + 1, fy + 1, fz, s), ux);
  const c = lerp(lattice(fx, fy, fz + 1, s), lattice(fx + 1, fy, fz + 1, s), ux);
  const d = lerp(lattice(fx, fy + 1, fz + 1, s), lattice(fx + 1, fy + 1, fz + 1, s), ux);
  return lerp(lerp(a, b, uy), lerp(c, d, uy), uz);
}

/** Four octaves of noise3, from about -1 to 1. */
function fbm3(x: number, y: number, z: number, s: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < 4; o++) {
    sum += amp * (noise3(x * f, y * f, z * f, s + o) * 2 - 1);
    amp *= 0.5;
    f *= 2;
  }
  return sum / 0.9375;
}

class Buf {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];
  get count() {
    return this.positions.length / 3;
  }
  vertex(p: V, n: V, c: V, u = 0, v = 0): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    // Godot keeps vertex colours as 8-bit values from 0 to 1.
    this.colors.push(clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1));
    this.uvs.push(u, v);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) {
    this.indices.push(a, b, c);
  }
  mesh(): NatureMesh {
    return { positions: this.positions, normals: this.normals, colors: this.colors, uvs: this.uvs, indices: this.indices };
  }
}

// ---- rocks ------------------------------------------------------------------------------------

const ROCK_RINGS = 16;
const ROCK_SEGMENTS = 28;

/** A rock about 1.8 m across and 1 m tall, its bottom 0.2 m under the ground. */
function rock(variant: number): NatureMesh {
  const r = rng(11001 + variant);
  const ox = r.between(0, 50);
  const oy = r.between(0, 50);
  const oz = r.between(0, 50);
  const sx = r.between(0.9, 1.2);
  const sy = r.between(0.55, 0.75);
  const sz = r.between(0.8, 1.1);
  // Flat broken faces: where a plane cuts closer than the rounded shape.
  const planes: [number, number, number, number][] = [];
  for (let p = 0; p < 5; p++) {
    const a = r.next() * TAU;
    const e = r.between(-0.25, 0.95);
    const c = r.between(0.74, 0.92);
    planes.push([Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a), c]);
  }
  const warm = r.next();
  const bright = r.between(0.85, 1.08);
  const moss = r.between(-0.3, 1);
  const base: V = [(0.5 + 0.07 * warm) * bright, (0.51 + 0.01 * warm) * bright, (0.51 - 0.06 * warm) * bright];

  const dirs: V[] = [[0, 1, 0]];
  for (let i = 1; i < ROCK_RINGS; i++) {
    const th = (Math.PI * i) / ROCK_RINGS;
    for (let j = 0; j < ROCK_SEGMENTS; j++) {
      const ph = (TAU * j) / ROCK_SEGMENTS;
      dirs.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
    }
  }
  dirs.push([0, -1, 0]);
  const count = dirs.length;
  const pos: V[] = [];
  const fine: number[] = [];
  for (const [x, y, z] of dirs) {
    const detail = fbm3(x * 4.5 + oz, y * 4.5 + ox, z * 4.5 + oy, 31);
    let rad = 1 + 0.26 * fbm3(x * 1.4 + ox, y * 1.4 + oy, z * 1.4 + oz, 17) + 0.06 * detail;
    for (const p of planes) {
      const k = x * p[0] + y * p[1] + z * p[2];
      if (k > 0.05) rad = Math.min(rad, p[3] / k);
    }
    pos.push([x * rad * sx, y * rad * sy, z * rad * sz]);
    fine.push(detail);
  }
  // 0.92 m from the middle at its widest, 0.2 m sunk into the ground.
  let reach = 0;
  let low = Infinity;
  for (const p of pos) {
    reach = Math.max(reach, Math.sqrt(p[0] * p[0] + p[2] * p[2]));
    low = Math.min(low, p[1]);
  }
  const scale = 0.92 / reach;
  const lift = -low * scale - 0.2;
  for (const p of pos) {
    p[0] *= scale;
    p[1] = p[1] * scale + lift;
    p[2] *= scale;
  }

  const S = ROCK_SEGMENTS;
  const last = count - 1;
  const tris: number[] = [];
  for (let j = 0; j < S; j++) tris.push(0, 1 + ((j + 1) % S), 1 + j);
  for (let i = 1; i < ROCK_RINGS - 1; i++) {
    for (let j = 0; j < S; j++) {
      const a = 1 + (i - 1) * S + j;
      const b = 1 + (i - 1) * S + ((j + 1) % S);
      tris.push(a, b, a + S, b, b + S, a + S);
    }
  }
  for (let j = 0; j < S; j++) tris.push(1 + (ROCK_RINGS - 2) * S + j, 1 + (ROCK_RINGS - 2) * S + ((j + 1) % S), last);

  const nrm: V[] = pos.map(() => [0, 0, 0]);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    const f = cross(sub(pos[b]!, pos[a]!), sub(pos[c]!, pos[a]!));
    for (const v of [a, b, c]) nrm[v] = add(nrm[v]!, f);
  }

  const buf = new Buf();
  for (let v = 0; v < count; v++) {
    const n = normalize(nrm[v]!);
    const [x, y, z] = dirs[v]!;
    const mottle = noise3(x * 6 + oy, y * 6 + oz, z * 6 + ox, 47);
    const shade = (0.8 + 0.36 * mottle) * clamp(1 + 2.2 * Math.min(fine[v]!, 0), 0.55, 1);
    let c = mul(base, shade);
    const m = clamp(moss, 0, 1) * smoothstep(0.35, 0.8, n[1]) * smoothstep(0.42, 0.62, noise3(x * 3 + oz, y * 3 + ox, z * 3 + oy, 53));
    c = mix(c, [0.3, 0.38, 0.17], m);
    const ground = 0.55 + 0.45 * smoothstep(-0.2, 0.3, pos[v]![1]);
    buf.vertex(pos[v]!, n, [c[0] * ground, c[1] * ground, c[2] * ground]);
  }
  for (let t = 0; t < tris.length; t += 3) buf.tri(tris[t]!, tris[t + 1]!, tris[t + 2]!);
  return buf.mesh();
}

// ---- trees ------------------------------------------------------------------------------------

/** A bark tube through `pts` with the given radii, `sides` round, its colour varied by noise. */
function tube(buf: Buf, pts: V[], radii: number[], sides: number, bark: V, s: number, gnarl: number) {
  const m = pts.length;
  const first = buf.count;
  const t0 = normalize(sub(pts[1]!, pts[0]!));
  const a: V = Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  let b1 = normalize(cross(t0, a));
  for (let i = 0; i < m; i++) {
    const t = i === 0 ? normalize(sub(pts[1]!, pts[0]!)) : i === m - 1 ? normalize(sub(pts[m - 1]!, pts[m - 2]!)) : normalize(sub(pts[i + 1]!, pts[i - 1]!));
    b1 = normalize(sub(b1, mul(t, dot(b1, t))));
    const b2 = cross(t, b1);
    const p = pts[i]!;
    for (let k = 0; k < sides; k++) {
      const ang = (TAU * k) / sides;
      const dir = add(mul(b1, Math.cos(ang)), mul(b2, Math.sin(ang)));
      const rad = radii[i]! * (1 + gnarl * (noise3(dir[0] * 1.5, p[1] * 0.9, dir[2] * 1.5, s) * 2 - 1));
      const q = add(p, mul(dir, rad));
      const shade = (0.78 + 0.4 * noise3(q[0] * 2.5, q[1] * 0.7, q[2] * 2.5, s + 3)) * (0.6 + 0.4 * smoothstep(-0.1, 0.6, q[1]));
      buf.vertex(q, dir, [bark[0] * shade, bark[1] * shade, bark[2] * shade]);
    }
  }
  for (let i = 0; i < m - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const A = first + i * sides + k;
      const B = first + i * sides + ((k + 1) % sides);
      buf.tri(A, B, A + sides);
      buf.tri(B, B + sides, A + sides);
    }
  }
}

/**
 * A leaf card: centre c, unit vectors a1 (across the picture) and a2 (up it), w by h metres, showing
 * `region` of the leaf picture. Each corner's normal leans away from `from` (soft, rounded shading
 * over the whole crown). Both sides are drawn, sharing the corners.
 */
function card(buf: Buf, c: V, a1: V, a2: V, w: number, h: number, region: readonly number[], tint: V, from: V, bend: number) {
  const nrm = cross(a1, a2);
  const [u0, v0, du, dv] = region as [number, number, number, number];
  const corners: [number, number, number, number][] = [
    [-0.5, -0.5, u0, v0 + dv],
    [0.5, -0.5, u0 + du, v0 + dv],
    [0.5, 0.5, u0 + du, v0],
    [-0.5, 0.5, u0, v0],
  ];
  const color: V = [tint[0], tint[1], tint[2]];
  const at = buf.count;
  for (const [x, y, u, v] of corners) {
    const p = add(c, add(mul(a1, x * w), mul(a2, y * h)));
    const n = normalize(add(mul(nrm, 1 - bend), mul(normalize(sub(p, from)), bend)));
    buf.vertex(p, n, color, u, v);
  }
  buf.tri(at, at + 1, at + 2);
  buf.tri(at, at + 2, at + 3);
  buf.tri(at, at + 2, at + 1);
  buf.tri(at, at + 3, at + 2);
}

/** Leaf cards round a clump's centre, more of them towards its outside. */
function clump(buf: Buf, r: Rng, centre: V, radius: number, crown: V, region: readonly number[], squash: number, size: number, tint: V) {
  const n = 6 + Math.floor(radius * 10);
  for (let i = 0; i < n; i++) {
    const z = r.next() * 2 - 1;
    const ph = r.next() * TAU;
    const ring = Math.sqrt(Math.max(0, 1 - z * z));
    const u: V = [ring * Math.cos(ph), z, ring * Math.sin(ph)];
    const q = 0.55 + 0.45 * r.next();
    const c: V = [centre[0] + u[0] * radius * q, centre[1] + u[1] * radius * q * squash, centre[2] + u[2] * radius * q];
    const jx = r.next() - 0.5;
    const jy = r.next() - 0.5;
    const jz = r.next() - 0.5;
    const nrm = normalize(add(u, mul([jx, jy, jz], 0.9)));
    const ref: V = Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t1 = normalize(cross(ref, nrm));
    const t2 = cross(nrm, t1);
    const al = r.next() * TAU;
    const a1 = add(mul(t1, Math.cos(al)), mul(t2, Math.sin(al)));
    const a2 = sub(mul(t2, Math.cos(al)), mul(t1, Math.sin(al)));
    const sz = size * r.between(0.8, 1.15);
    const g = r.between(0.8, 1.08);
    const hue = r.between(-0.05, 0.05);
    const out = normalize(sub(c, crown));
    const ao = (0.5 + 0.5 * q) * (0.62 + 0.38 * clamp(0.5 + 0.6 * out[1], 0, 1));
    card(buf, c, a1, a2, sz, sz, region, [tint[0] * g * (1 + hue) * ao, tint[1] * g * ao, tint[2] * g * (1 - hue) * ao], crown, 0.65);
  }
}

/** A broad-leaved tree about 4.5 m tall: a trunk, four or five boughs with two twigs each, and clumps of leaves. */
function roundTree(bark: Buf, leaves: Buf, r: Rng, s: number) {
  const leanA = r.next() * TAU;
  const lean = r.between(0, 0.14);
  const lx = Math.cos(leanA) * lean;
  const lz = Math.sin(leanA) * lean;
  const at = (t: number): V => [lx * t * t * 2.95, -0.25 + 2.95 * t, lz * t * t * 2.95];
  const trunk: V[] = [];
  const radii: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const p = at(t);
    const f = Math.max(0, 1 - p[1] / 0.45);
    trunk.push(p);
    radii.push(0.27 * (1 - 0.45 * t) + 0.16 * f * f);
  }
  tube(bark, trunk, radii, 10, BARK_ROUND, s, 0.06);
  const crown: V = [lx * 2, 3.2, lz * 2];
  const clumps: [V, number][] = [];
  const nb = 4 + Math.floor(r.next() * 2);
  const az0 = r.next() * TAU;
  for (let b = 0; b < nb; b++) {
    const h = 1.85 + (0.8 * b) / (nb - 1) + r.between(-0.08, 0.08);
    const start = at((h + 0.25) / 2.95);
    const az = az0 + b * 2.39996 + r.between(-0.35, 0.35);
    const up = r.between(0.5, 1);
    const d = normalize([Math.cos(az), up, Math.sin(az)]);
    const length = r.between(0.7, 0.95);
    const bend = (u: number): V => add(add(start, mul(d, length * u)), [0, 0.18 * length * u * u, 0]);
    const pts: V[] = [];
    const rr: number[] = [];
    for (let k = 0; k < 4; k++) {
      pts.push(bend(k / 3));
      rr.push(lerp(0.11, 0.025, k / 3));
    }
    tube(bark, pts, rr, 6, BARK_ROUND, s + 10 + b, 0);
    clumps.push([pts[3]!, r.between(0.68, 0.82)]);
    for (let sb = 0; sb < 2; sb++) {
      const base = bend(0.5 + 0.3 * sb);
      const side = mul([-Math.sin(az), 0, Math.cos(az)], sb === 0 ? 1 : -1);
      const spread = r.between(0.4, 0.8);
      const rise = r.between(0.1, 0.4);
      const sd = normalize(add(add(d, mul(side, spread)), [0, rise, 0]));
      const sl = r.between(0.3, 0.45);
      tube(bark, [base, add(base, mul(sd, sl * 0.5)), add(base, mul(sd, sl))], [0.045, 0.03, 0.012], 4, BARK_ROUND, s + 20 + b * 2 + sb, 0);
      clumps.push([add(base, mul(sd, sl)), r.between(0.48, 0.6)]);
    }
  }
  clumps.push([add(trunk[6]!, [0, 0.35, 0]), r.between(0.72, 0.86)]);
  for (const [c, rad] of clumps) clump(leaves, r, c, rad, crown, BROAD, 1, 0.9, LEAF_ROUND);
}

/** A pine about 6 m tall: a tapering trunk with whorls of drooping boughs covered in needles. */
function pineTree(bark: Buf, leaves: Buf, r: Rng, s: number) {
  const leanA = r.next() * TAU;
  const lean = r.between(0, 0.08);
  const lx = Math.cos(leanA) * lean;
  const lz = Math.sin(leanA) * lean;
  const at = (y: number): V => {
    const t = (y + 0.2) / 6.1;
    return [lx * t * t * 6.1, y, lz * t * t * 6.1];
  };
  const trunk: V[] = [];
  const radii: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const y = -0.2 + 6.1 * t;
    const f = Math.max(0, 1 - y / 0.35);
    trunk.push(at(y));
    radii.push(0.24 * (1 - t) + 0.012 + 0.12 * f * f);
  }
  tube(bark, trunk, radii, 8, BARK_PINE, s, 0.05);
  for (let w = 0; w < 15; w++) {
    const y = 1.35 + 0.3 * w + r.between(-0.06, 0.06);
    const rel = (y - 1.35) / 4.5;
    const start = at(y);
    const n = 5 + Math.floor(r.next() * 2);
    const length = 1.1 * Math.pow(Math.max(0, 1 - rel), 0.85) + 0.16;
    for (let b = 0; b < n; b++) {
      const az = w * 0.9 + (b * TAU) / n + r.between(-0.25, 0.25);
      const droop = r.between(-0.35, -0.12);
      const d = normalize([Math.cos(az), droop, Math.sin(az)]);
      const end = add(add(start, mul(d, length)), [0, 0.12 * length, 0]);
      const mid = add(add(start, mul(d, length * 0.5)), [0, 0.03 * length, 0]);
      const br = 0.035 * (1 - rel * 0.6);
      tube(bark, [start, mid, end], [br, br * 0.6, 0.008], 4, BARK_PINE, s + 30 + w, 0);
      const along = normalize(sub(end, start));
      const across = normalize(cross([0, 1, 0], along));
      const up = cross(along, across);
      for (let k = 0; k < 3; k++) {
        const u = 0.25 + 0.3 * k;
        const c = mix(start, end, u);
        const beta = r.between(-0.5, 0.5);
        const g = r.between(0.85, 1.1);
        const ao = (0.55 + 0.45 * u) * (0.7 + 0.3 * rel) * g;
        const from: V = [start[0], c[1] - 0.6, start[2]];
        for (let x = 0; x < 2; x++) {
          const bb = beta + 1.25 * x;
          const a2 = add(mul(across, Math.cos(bb)), mul(up, Math.sin(bb)));
          card(leaves, c, along, a2, length * 0.75 + 0.25, 0.5 + 0.3 * (1 - rel), NEEDLES, mul(LEAF_PINE, ao), from, 0.7);
        }
      }
    }
  }
  const top = trunk[8]!;
  for (let k = 0; k < 3; k++) {
    const az = (k * TAU) / 3 + r.next();
    card(leaves, add(top, [0, -0.25, 0]), [0, 1, 0], [Math.cos(az), 0, Math.sin(az)], 0.7, 0.55, NEEDLES, LEAF_PINE, [top[0], top[1] - 1, top[2]], 0.7);
  }
}

/** A baobab: a thick, folded trunk about 3.6 m tall with crooked boughs and a flat, open crown. */
function baobabTree(bark: Buf, leaves: Buf, r: Rng, s: number) {
  const rb = r.between(0.78, 0.88);
  const trunk: V[] = [];
  const radii: number[] = [];
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const y = -0.25 + 3.95 * t;
    const f = Math.max(0, 1 - y / 0.6);
    trunk.push([0, y, 0]);
    radii.push(rb * (1.15 - 0.38 * t + 0.14 * Math.sin(Math.PI * t)) + 0.3 * f * f);
  }
  tube(bark, trunk, radii, 14, BARK_BAOBAB, s, 0.1);
  const topR = radii[7]!;
  const crown: V = [0, 4.1, 0];
  const nb = 6 + Math.floor(r.next() * 3);
  const az0 = r.next() * TAU;
  for (let b = 0; b < nb; b++) {
    const az = az0 + (b * TAU) / nb + r.between(-0.3, 0.3);
    const out: V = [Math.cos(az), 0, Math.sin(az)];
    const start = add([0, 3.5 + r.between(0, 0.2), 0], mul(out, topR * 0.55));
    const up = r.between(0.2, 0.45);
    const d = normalize(add(out, [0, up, 0]));
    const length = r.between(1.0, 1.45);
    const side: V = [-out[2], 0, out[0]];
    const pts: V[] = [start];
    const rr = [0.26];
    for (let k = 1; k < 4; k++) {
      const u = k / 3;
      const wob = r.between(-0.12, 0.12);
      pts.push(add(add(add(start, mul(d, length * u)), mul(side, wob)), [0, 0.12 * length * u * u, 0]));
      rr.push(lerp(0.26, 0.07, u));
    }
    tube(bark, pts, rr, 7, BARK_BAOBAB, s + 40 + b, 0);
    clump(leaves, r, add(pts[3]!, [0, 0.15, 0]), r.between(0.55, 0.7), crown, BROAD, 0.55, 0.75, LEAF_BAOBAB);
    const base = pts[2]!;
    const spread = r.between(-0.9, 0.9);
    const sd = normalize(add(add(d, mul(side, spread)), [0, 0.3, 0]));
    const sl = r.between(0.5, 0.8);
    tube(bark, [base, add(base, mul(sd, sl))], [0.08, 0.03], 5, BARK_BAOBAB, s + 60 + b, 0);
    clump(leaves, r, add(add(base, mul(sd, sl)), [0, 0.1, 0]), r.between(0.4, 0.5), crown, BROAD, 0.55, 0.65, LEAF_BAOBAB);
  }
}

const cache = new Map<string, NatureMesh[]>();

/**
 * The meshes of one shape: [rock] for a rock, [bark, leaves] for a tree. Leaves carry the leaf
 * picture's coordinates (uvs); the bark and rock only colours.
 */
export function natureMeshes(kind: NatureKind, variant: number): NatureMesh[] {
  const key = `${kind}|${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let made: NatureMesh[];
  if (kind === "rock") made = [rock(variant)];
  else {
    const seed = (kind === "tall" ? 37001 : kind === "baobab" ? 51001 : 23001) + variant;
    const r = rng(seed);
    const bark = new Buf();
    const leaves = new Buf();
    if (kind === "tall") pineTree(bark, leaves, r, seed);
    else if (kind === "baobab") baobabTree(bark, leaves, r, seed);
    else roundTree(bark, leaves, r, seed);
    made = [bark.mesh(), leaves.mesh()];
  }
  cache.set(key, made);
  return made;
}
