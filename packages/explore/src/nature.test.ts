import { describe, expect, it } from "vitest";
import { NATURE_VARIANTS, natureMeshes, noise3, seedOf, turnOf, variantOf, type NatureKind, type NatureMesh } from "./nature";

const KINDS: NatureKind[] = ["round", "tall", "baobab", "rock"];

function bounds(m: NatureMesh) {
  let minY = Infinity;
  let maxY = -Infinity;
  let reach = 0;
  for (let i = 0; i < m.positions.length; i += 3) {
    minY = Math.min(minY, m.positions[i + 1]!);
    maxY = Math.max(maxY, m.positions[i + 1]!);
    reach = Math.max(reach, Math.hypot(m.positions[i]!, m.positions[i + 2]!));
  }
  return { minY, maxY, reach };
}

describe("detailed trees and rocks (nature.ts, the same as the game's nature.gd)", () => {
  it("picks a shape and a turn from the object's id (32-bit FNV-1a of its UTF-8 bytes)", () => {
    // Worked out separately (Python): the game's seed_of must give the same.
    expect(seedOf("tree_1")).toBe(4214621853);
    expect(seedOf("rock_1")).toBe(498821952);
    expect(seedOf("é")).toBe(513665217);
    expect(variantOf("tree_1")).toBe(1);
    expect(variantOf("rock_1")).toBe(0);
    for (const id of ["a", "tree_7", "baobab_1", "rock_12"]) {
      expect(variantOf(id)).toBeGreaterThanOrEqual(0);
      expect(variantOf(id)).toBeLessThan(NATURE_VARIANTS);
      expect(turnOf(id)).toBeGreaterThanOrEqual(0);
      expect(turnOf(id)).toBeLessThan(Math.PI * 2);
    }
    expect(turnOf("rock_1")).not.toBeCloseTo(turnOf("rock_2"), 3);
  });

  it("makes well-formed meshes: every triangle names real corners, normals have length 1, colours run 0 to 1", () => {
    for (const kind of KINDS) {
      for (let v = 0; v < NATURE_VARIANTS; v++) {
        for (const m of natureMeshes(kind, v)) {
          const count = m.positions.length / 3;
          expect(m.normals.length).toBe(count * 3);
          expect(m.colors.length).toBe(count * 3);
          expect(m.uvs.length).toBe(count * 2);
          expect(m.indices.length % 3).toBe(0);
          expect(m.indices.every((i) => Number.isInteger(i) && i >= 0 && i < count)).toBe(true);
          for (let i = 0; i < count; i++) {
            expect(Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!)).toBeCloseTo(1, 5);
          }
          expect(m.colors.every((c) => c >= 0 && c <= 1)).toBe(true);
          expect(m.positions.every(Number.isFinite)).toBe(true);
        }
      }
    }
  });

  it("keeps each kind about the size of the simple shape it replaces", () => {
    for (let v = 0; v < NATURE_VARIANTS; v++) {
      const rock = bounds(natureMeshes("rock", v)[0]!);
      expect(rock.reach).toBeCloseTo(0.92, 5);
      expect(rock.minY).toBeCloseTo(-0.2, 5);
      expect(rock.maxY).toBeGreaterThan(0.75);
      expect(rock.maxY).toBeLessThan(1.1);
      const sizes: Record<string, { top: [number, number]; reach: number }> = {
        round: { top: [3.9, 4.8], reach: 2.0 },
        tall: { top: [5.8, 6.1], reach: 1.8 },
        baobab: { top: [4.6, 5.3], reach: 2.6 },
      };
      for (const [kind, want] of Object.entries(sizes)) {
        const [bark, leaves] = natureMeshes(kind as NatureKind, v).map(bounds);
        expect(bark!.minY).toBeLessThan(0);
        expect(leaves!.maxY).toBeGreaterThan(want.top[0]);
        expect(leaves!.maxY).toBeLessThan(want.top[1]);
        expect(Math.max(bark!.reach, leaves!.reach)).toBeLessThan(want.reach);
      }
    }
  });

  it("winds a rock's triangles counter-clockwise seen from outside", () => {
    for (let v = 0; v < NATURE_VARIANTS; v++) {
      const m = natureMeshes("rock", v)[0]!;
      const p = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
      let middle = [0, 0, 0];
      const count = m.positions.length / 3;
      for (let i = 0; i < count; i++) middle = middle.map((x, k) => x + p(i)[k]! / count);
      let outward = 0;
      for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [p(m.indices[t]!), p(m.indices[t + 1]!), p(m.indices[t + 2]!)];
        const u = b.map((x, k) => x - a[k]!);
        const w = c.map((x, k) => x - a[k]!);
        const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
        const out = a.map((x, k) => x - middle[k]!);
        if (n[0]! * out[0]! + n[1]! * out[1]! + n[2]! * out[2]! > 0) outward++;
      }
      expect(outward).toBe(m.indices.length / 3);
    }
  });

  it("draws leaves on both sides of each card, from the right half of the picture for pines", () => {
    const round = natureMeshes("round", 0)[1]!;
    const pine = natureMeshes("tall", 0)[1]!;
    // Four corners and four triangles (two each way) per card.
    expect(round.indices.length / 3).toBe(round.positions.length / 3);
    expect(Math.min(...round.uvs.filter((_, i) => i % 2 === 0))).toBe(0);
    expect(Math.max(...round.uvs.filter((_, i) => i % 2 === 0))).toBe(0.5);
    expect(Math.min(...pine.uvs.filter((_, i) => i % 2 === 0))).toBe(0.5);
    expect(Math.max(...pine.uvs.filter((_, i) => i % 2 === 0))).toBe(1);
  });

  it("gives the same mesh every time, and different shapes for different variants", () => {
    const a = natureMeshes("round", 2)[0]!;
    expect(natureMeshes("round", 2)[0]).toBe(a);
    expect(natureMeshes("round", 3)[0]!.positions).not.toEqual(a.positions);
    expect(natureMeshes("rock", 1)[0]!.positions).not.toEqual(natureMeshes("rock", 2)[0]!.positions);
  });

  it("has smooth noise from 0 to 1 that matches across lattice cells", () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.137 - 7;
      const n = noise3(x, x * 0.7, -x * 1.3, 5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
    expect(noise3(2 - 1e-9, 0.5, 0.5, 1)).toBeCloseTo(noise3(2, 0.5, 0.5, 1), 6);
  });
});
