import type { Catalog, Creature, Element, Move } from "./creatures";

/**
 * Deterministic one-on-one encounter. No randomness: every move hits, the faster creature
 * acts first (ties go to side A) and a creature reduced to 0 HP cannot act.
 * Damage (original formula) = max(1, floor(power * attack / (defense + 20) * effectiveness / 2)).
 */
export type Side = "a" | "b";

export interface Combatant {
  creatureId: string;
  name: string;
  element: Element;
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;
  moves: Move[];
}

export type EncounterEvent =
  | { type: "move"; side: Side; move: string; damage: number; effectiveness: number; targetHp: number }
  | { type: "faint"; side: Side }
  | { type: "end"; winner: Side; xp: number };

export interface EncounterState {
  a: Combatant;
  b: Combatant;
  round: number;
  winner: Side | null;
  events: EncounterEvent[];
}

export function combatant(creature: Creature): Combatant {
  return { creatureId: creature.id, name: creature.name, element: creature.element, hp: creature.stats.hp, maxHp: creature.stats.hp, attack: creature.stats.attack, defense: creature.stats.defense, speed: creature.stats.speed, moves: creature.moves };
}

export function startEncounter(catalog: Catalog, a: string, b: string): EncounterState {
  const find = (id: string) => {
    const c = catalog.creatures.find((x) => x.id === id);
    if (!c) throw new Error(`Unknown creature '${id}'`);
    return c;
  };
  return { a: combatant(find(a)), b: combatant(find(b)), round: 0, winner: null, events: [] };
}

export function effectivenessOf(catalog: Catalog, attack: Element, defend: Element): number {
  return catalog.effectiveness[attack]?.[defend] ?? 1;
}

export function damageFor(catalog: Catalog, attacker: Combatant, defender: Combatant, move: Move): { damage: number; effectiveness: number } {
  const effectiveness = effectivenessOf(catalog, move.element, defender.element);
  const raw = (move.power * attacker.attack) / (defender.defense + 20);
  return { damage: Math.max(1, Math.floor((raw * effectiveness) / 2)), effectiveness };
}

/** Highest damage move; ties go to the earlier move in the list. */
export function bestMove(catalog: Catalog, attacker: Combatant, defender: Combatant): string {
  let best = attacker.moves[0]!;
  let bestDamage = -1;
  for (const m of attacker.moves) {
    const d = damageFor(catalog, attacker, defender, m).damage;
    if (d > bestDamage) {
      best = m;
      bestDamage = d;
    }
  }
  return best.id;
}

/** Both sides choose a move; resolves one round and returns a new state. */
export function playRound(catalog: Catalog, state: EncounterState, moveA: string, moveB: string): EncounterState {
  if (state.winner) throw new Error("The encounter is over");
  const next: EncounterState = { a: { ...state.a }, b: { ...state.b }, round: state.round + 1, winner: null, events: [...state.events] };
  const chosen: Record<Side, Move> = {
    a: next.a.moves.find((m) => m.id === moveA) ?? fail(`${next.a.name} does not know '${moveA}'`),
    b: next.b.moves.find((m) => m.id === moveB) ?? fail(`${next.b.name} does not know '${moveB}'`),
  };
  const order: Side[] = next.a.speed >= next.b.speed ? ["a", "b"] : ["b", "a"];
  for (const side of order) {
    const attacker = next[side];
    const targetSide: Side = side === "a" ? "b" : "a";
    const defender = next[targetSide];
    if (attacker.hp <= 0) continue;
    const { damage, effectiveness } = damageFor(catalog, attacker, defender, chosen[side]);
    defender.hp = Math.max(0, defender.hp - damage);
    next.events.push({ type: "move", side, move: chosen[side].id, damage, effectiveness, targetHp: defender.hp });
    if (defender.hp === 0) {
      next.events.push({ type: "faint", side: targetSide });
      next.winner = side;
      next.events.push({ type: "end", winner: side, xp: Math.round(defender.maxHp / 2) });
      break;
    }
  }
  return next;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Replays a list of rounds; the same inputs always give the same result. */
export function replayEncounter(catalog: Catalog, a: string, b: string, rounds: [string, string][]): EncounterState {
  let s = startEncounter(catalog, a, b);
  for (const [ma, mb] of rounds) s = playRound(catalog, s, ma, mb);
  return s;
}
