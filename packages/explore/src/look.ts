/**
 * The 3D template's look, the parts the studio and the Godot game must compute alike: how much fog
 * covers the sky, the ground's patches, and where the grass grows (templates/exploration-3d/godot:
 * world_builder.gd sky_fog, shaders/ground.gdshader patches, scripts/grass.gd). The real-engine test
 * (packages/project, godot.integration.test.ts) checks that grass.gd places every tuft as placeTufts does.
 */
import type { World } from "./world";

/** How much fog covers the sky (Godot's fog_sky_affect): world_builder.gd, sky_fog. */
export function skyFog(density: number): number {
  return Math.min(1, Math.max(0, density * 12));
}

// ---- Noise, as the game's shaders and grass.gd compute it -----------------------------------

const fract = (x: number) => x - Math.floor(x);

export function hash2(x: number, y: number): number {
  let px = fract(x * 123.34);
  let py = fract(y * 456.21);
  const d = px * (px + 45.32) + py * (py + 45.32);
  px += d;
  py += d;
  return fract(px * py);
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const lerp = (p: number, q: number, t: number) => p + (q - p) * t;
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

/** The ground's patches at a point, 0 (lush) to 1 (dry): ground.gdshader's patches(). */
export function patches(x: number, z: number): number {
  const px = x / 16;
  const pz = z / 16;
  return valueNoise(px, pz) * 0.6 + valueNoise(px * 2.7 + 7.1, pz * 2.7 + 7.1) * 0.28 + valueNoise(px * 7.3 + 3.7, pz * 7.3 + 3.7) * 0.12;
}

export function smoothstep(from: number, to: number, x: number): number {
  const s = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return s * s * (3 - 2 * s);
}

/** A number from 0 to 1 for cell (i, j) and a salt: grass.gd's hash01 (32-bit integer arithmetic). */
export function hash01(i: number, j: number, salt: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(salt, 1274126177)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

// ---- Grass (grass.gd) -----------------------------------------------------------------------

const MAX_CELLS = 40000;

export function grassCellSize(density: number, width: number, depth: number): number {
  const d = Math.min(1, Math.max(0, density));
  const cell = 1.6 + (0.55 - 1.6) * d;
  return Math.max(cell, Math.sqrt((width * depth) / MAX_CELLS));
}

/** Circles kept clear of grass: water and visible zones ([x, z, radius]). */
export function grassKeepOut(world: World): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const o of world.objects) {
    if (o.type === "water") out.push([o.x, o.z, o.radius * o.scale + 0.3]);
    else if (o.type === "zone" && o.visible) out.push([o.x, o.z, o.radius * o.scale + 0.2]);
  }
  return out;
}

/** Where the tufts go: [x, z, turn in radians, size] for each, as grass.gd's place_tufts. */
export function placeTufts(width: number, depth: number, density: number, variation: number, keepOut: readonly (readonly [number, number, number])[]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  if (density <= 0) return out;
  const cell = grassCellSize(density, width, depth);
  const nx = Math.floor(width / cell);
  const nz = Math.floor(depth / cell);
  const x0 = -width / 2;
  const z0 = -depth / 2;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = x0 + (i + 0.15 + 0.7 * hash01(i, j, 1)) * cell;
      const z = z0 + (j + 0.15 + 0.7 * hash01(i, j, 2)) * cell;
      if (Math.abs(x) > width / 2 - 0.5 || Math.abs(z) > depth / 2 - 0.5) continue;
      const dry = smoothstep(0.3, 0.7, patches(x, z)) * variation;
      if (hash01(i, j, 3) > 0.9 - 0.55 * dry) continue;
      let blocked = false;
      for (const [kx, kz, r] of keepOut) {
        const dx = x - kx;
        const dz = z - kz;
        if (dx * dx + dz * dz < r * r) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push([x, z, hash01(i, j, 4) * Math.PI * 2, 0.75 + 0.55 * hash01(i, j, 5)]);
    }
  }
  return out;
}

