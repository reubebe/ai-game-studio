import { positionKey, type OwareState, type Player } from "./engine";

/** Build a position. Board seeds plus scores must total 48 for Abapa invariants to hold. */
export function position(pits: number[], toMove: Player = 0, scores: [number, number] = [0, 0]): OwareState {
  if (pits.length !== 12) throw new Error("A position needs 12 pits");
  return { pits, scores, toMove, ply: 10, status: "playing", result: null, positions: { [positionKey(pits, toMove)]: 1 } };
}

/** Deterministic pseudo-random numbers for property tests (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T;
}
