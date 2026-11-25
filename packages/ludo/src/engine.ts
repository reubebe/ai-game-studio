/**
 * Reference implementation of Ludo, parameterised by variant settings.
 *
 * Default settings implement the Classic rules documented in docs/rulesets/ludo-classic.md:
 * a 6 brings a token out, a 6 earns another roll, a third 6 in a row loses the turn, landing on an
 * opponent sends it back to its yard, and a token needs the exact count to reach home (Wikipedia, "Ludo",
 * citing Parlett 1999 and the Diagram Group 1975). Tokens of one colour may share a square without forming
 * a block, and the four start squares are safe: those two are common house rules and are settings here.
 *
 * Geometry: the main track has 52 squares; seat s (0 red, 1 green, 2 yellow, 3 blue, clockwise) enters
 * at square 13 * s. A token's progress is -1 in the yard, 0-50 on the main track (square (13 * s + p) % 52),
 * 51-55 in its home column and 56 at home. Dice come from a seeded generator kept in the state, so a game
 * replays exactly from its seed and actions. Every function is pure: states are never mutated.
 */

export const TRACK = 52;
export const HOME = 56;
export const LAST_TRACK = 50;
export const YARD = -1;
export const SEAT_NAMES = ["Red", "Green", "Yellow", "Blue"] as const;

export interface LudoConfig {
  tokens: number;
  /** Rolls that bring a token out of its yard. */
  enterOn: number[];
  /** A 6 earns another roll. */
  bonusOnSix: boolean;
  /** This many 6s in a row lose the turn (0 = no limit). */
  maxSixes: number;
  /** Capturing an opponent earns another roll. */
  bonusOnCapture: boolean;
  /** Bringing a token home earns another roll. */
  bonusOnHome: boolean;
  /** Two tokens of one colour on a square form a block opponents cannot pass or land on. */
  blocks: boolean;
  /** Tokens on any of the four start squares cannot be captured. */
  safeStarts: boolean;
  /** A token needs the exact count to reach home; otherwise an overshoot still finishes. */
  exactFinish: boolean;
}

export const CLASSIC: Readonly<LudoConfig> = Object.freeze({
  tokens: 4,
  enterOn: [6],
  bonusOnSix: true,
  maxSixes: 3,
  bonusOnCapture: false,
  bonusOnHome: false,
  blocks: false,
  safeStarts: true,
  exactFinish: true,
});

export interface LudoState {
  /** Seats in play order (2 players sit opposite: seats 0 and 2). */
  seats: readonly number[];
  /** tokens[i][t]: progress of token t of the i-th player. */
  tokens: readonly (readonly number[])[];
  /** Index into seats of the player whose turn it is. */
  toMove: number;
  /** The roll waiting to be used, or null when the player must roll. */
  dice: number | null;
  /** 6s rolled in a row this turn. */
  sixes: number;
  /** Seeded generator state (mulberry32). */
  rng: number;
  seed: number;
  /** Rolls made so far. */
  rolls: number;
  status: "playing" | "finished";
  winner: number | null;
}

export type LudoEvent =
  | { type: "roll"; player: number; value: number }
  | { type: "sixes"; player: number; count: number }
  | { type: "no-move"; player: number; value: number }
  | { type: "enter"; player: number; token: number }
  | { type: "move"; player: number; token: number; from: number; to: number }
  | { type: "capture"; player: number; victims: { player: number; token: number }[] }
  | { type: "home"; player: number; token: number }
  | { type: "again"; player: number }
  | { type: "turn"; player: number }
  | { type: "win"; player: number };

export type IllegalReason = "over" | "no-roll" | "finished" | "needs-entry-roll" | "overshoot" | "blocked" | "no-token";

export const ILLEGAL_MESSAGES: Record<IllegalReason, string> = {
  over: "The game is over.",
  "no-roll": "Roll the die first.",
  finished: "That token is already home.",
  "needs-entry-roll": "A token leaves its yard only on an entry roll (a 6).",
  overshoot: "That roll would take the token past home; it needs the exact count.",
  blocked: "A block stands in the way.",
  "no-token": "There is no such token.",
};

export function seatsFor(players: number): number[] {
  if (players === 2) return [0, 2];
  if (players === 3) return [0, 1, 2];
  if (players === 4) return [0, 1, 2, 3];
  throw new Error("Ludo is for 2 to 4 players");
}

export function createInitialState(config: LudoConfig, players: number, seed: number): LudoState {
  const seats = seatsFor(players);
  return {
    seats,
    tokens: seats.map(() => Array.from({ length: config.tokens }, () => YARD)),
    toMove: 0,
    dice: null,
    sixes: 0,
    rng: seed >>> 0,
    seed: seed >>> 0,
    rolls: 0,
    status: "playing",
    winner: null,
  };
}

/** mulberry32: one step of the dice generator. Returns the next generator state and a value in [0, 1). */
export function nextRandom(rng: number): { rng: number; value: number } {
  const a = (rng + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { rng: a, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

export function rollDie(state: LudoState): { state: LudoState; value: number } {
  const r = nextRandom(state.rng);
  const value = 1 + Math.floor(r.value * 6);
  return { state: { ...state, rng: r.rng, rolls: state.rolls + 1 }, value };
}

/** The main-track square a player's token stands on, or null when it is in the yard, home column or home. */
export function squareOf(seat: number, progress: number): number | null {
  return progress >= 0 && progress <= LAST_TRACK ? (seat * 13 + progress) % TRACK : null;
}

export function isStartSquare(square: number): boolean {
  return square % 13 === 0;
}

/** Opponent tokens on a main-track square: [player index, token index]. */
export function occupants(state: LudoState, square: number): { player: number; token: number }[] {
  const out: { player: number; token: number }[] = [];
  state.tokens.forEach((list, player) =>
    list.forEach((p, token) => {
      if (squareOf(state.seats[player]!, p) === square) out.push({ player, token });
    }),
  );
  return out;
}

function opponentBlockOn(state: LudoState, mover: number, square: number): boolean {
  const counts = new Map<number, number>();
  for (const o of occupants(state, square)) if (o.player !== mover) counts.set(o.player, (counts.get(o.player) ?? 0) + 1);
  return [...counts.values()].some((n) => n >= 2);
}

/** Where a token would go with a roll, or why it cannot move. */
export function checkMove(state: LudoState, token: number, config: LudoConfig): { legal: true; to: number } | { legal: false; reason: IllegalReason } {
  if (state.status !== "playing") return { legal: false, reason: "over" };
  if (state.dice === null) return { legal: false, reason: "no-roll" };
  const mine = state.tokens[state.toMove]!;
  if (!Number.isInteger(token) || token < 0 || token >= mine.length) return { legal: false, reason: "no-token" };
  const p = mine[token]!;
  const seat = state.seats[state.toMove]!;
  const d = state.dice;
  if (p === HOME) return { legal: false, reason: "finished" };
  if (p === YARD) {
    if (!config.enterOn.includes(d)) return { legal: false, reason: "needs-entry-roll" };
    if (config.blocks && opponentBlockOn(state, state.toMove, squareOf(seat, 0)!)) return { legal: false, reason: "blocked" };
    return { legal: true, to: 0 };
  }
  let to = p + d;
  if (to > HOME) {
    if (config.exactFinish) return { legal: false, reason: "overshoot" };
    to = HOME;
  }
  if (config.blocks) {
    for (let step = p + 1; step <= Math.min(to, LAST_TRACK); step++) {
      if (opponentBlockOn(state, state.toMove, squareOf(seat, step)!)) return { legal: false, reason: "blocked" };
    }
  }
  return { legal: true, to };
}

export function legalTokens(state: LudoState, config: LudoConfig): number[] {
  if (state.status !== "playing" || state.dice === null) return [];
  return state.tokens[state.toMove]!.map((_, t) => t).filter((t) => checkMove(state, t, config).legal);
}

export function passTurn(state: LudoState): LudoState {
  return { ...state, toMove: (state.toMove + 1) % state.seats.length, dice: null, sixes: 0 };
}

function setToken(state: LudoState, player: number, token: number, progress: number): LudoState {
  return { ...state, tokens: state.tokens.map((list, i) => (i === player ? list.map((p, t) => (t === token ? progress : p)) : list)) };
}

/** Moves a token (the move must be legal) and resolves captures. Leaves the turn and dice untouched. */
export function advance(state: LudoState, token: number, to: number): LudoState {
  return setToken(state, state.toMove, token, to);
}

/** Sends opponents on the mover's landing square back to their yards. */
export function resolveCapture(state: LudoState, token: number, config: LudoConfig): { state: LudoState; victims: { player: number; token: number }[] } {
  const seat = state.seats[state.toMove]!;
  const square = squareOf(seat, state.tokens[state.toMove]![token]!);
  if (square === null || (config.safeStarts && isStartSquare(square))) return { state, victims: [] };
  const victims = occupants(state, square).filter((o) => o.player !== state.toMove);
  let next = state;
  for (const v of victims) next = setToken(next, v.player, v.token, YARD);
  return { state: next, victims };
}

export function hasWon(state: LudoState, player: number): boolean {
  return state.tokens[player]!.every((p) => p === HOME);
}

export interface StepResult {
  state: LudoState;
  events: LudoEvent[];
}

/** Reference: a complete roll action. */
export function applyRoll(state: LudoState, config: LudoConfig): StepResult {
  if (state.status !== "playing" || state.dice !== null) return { state, events: [] };
  const player = state.toMove;
  const rolled = rollDie(state);
  const value = rolled.value;
  const sixes = value === 6 ? state.sixes + 1 : state.sixes;
  const events: LudoEvent[] = [{ type: "roll", player, value }];
  let next: LudoState = { ...rolled.state, dice: value, sixes };
  if (value === 6 && config.maxSixes > 0 && sixes >= config.maxSixes) {
    events.push({ type: "sixes", player, count: sixes });
    next = passTurn(next);
    events.push({ type: "turn", player: next.toMove });
    return { state: next, events };
  }
  if (legalTokens(next, config).length === 0) {
    events.push({ type: "no-move", player, value });
    if (value === 6 && config.bonusOnSix) {
      next = { ...next, dice: null };
      events.push({ type: "again", player });
    } else {
      next = passTurn(next);
      events.push({ type: "turn", player: next.toMove });
    }
  }
  return { state: next, events };
}

/** Reference: a complete move action. Returns null when the move is illegal. */
export function applyMove(state: LudoState, token: number, config: LudoConfig): StepResult | null {
  const check = checkMove(state, token, config);
  if (!check.legal) return null;
  const player = state.toMove;
  const from = state.tokens[player]![token]!;
  const value = state.dice!;
  const events: LudoEvent[] = [from === YARD ? { type: "enter", player, token } : { type: "move", player, token, from, to: check.to }];
  let next = advance(state, token, check.to);
  const cap = resolveCapture(next, token, config);
  next = cap.state;
  if (cap.victims.length > 0) events.push({ type: "capture", player, victims: cap.victims });
  const reachedHome = check.to === HOME;
  if (reachedHome) events.push({ type: "home", player, token });
  if (hasWon(next, player)) {
    events.push({ type: "win", player });
    return { state: { ...next, dice: null, status: "finished", winner: player }, events };
  }
  const again = (value === 6 && config.bonusOnSix) || (cap.victims.length > 0 && config.bonusOnCapture) || (reachedHome && config.bonusOnHome);
  if (again) {
    events.push({ type: "again", player });
    return { state: { ...next, dice: null }, events };
  }
  next = passTurn(next);
  events.push({ type: "turn", player: next.toMove });
  return { state: next, events };
}

export function playerName(state: LudoState, player: number): string {
  return SEAT_NAMES[state.seats[player]!] ?? `Player ${player + 1}`;
}
