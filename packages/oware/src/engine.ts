/**
 * Reference implementation of Oware, parameterized by variant settings.
 *
 * Default settings implement the Abapa rules as documented by:
 *  - Wikipedia, "Oware" (Abapa rules section), accessed 2026-11-18
 *  - Joan Sala, "How to play Oware" (Aualé), accessed 2026-11-18
 * See docs/rulesets/oware-abapa.md for the rule text, the sources and the
 * interpretation choices this implementation makes.
 *
 * NAMNAM implements Nam-nam, the beginner rules taught in First Step Tours' video
 * "Basic Oware Rules for Beginners" and written up on oware.org's "Nam-Nam Rules":
 * relay sowing, fours taken by the owner of the house as they form, the last eight
 * seeds, and rounds in which houses change hands (docs/rulesets/oware-namnam.md).
 *
 * Board indexing follows sowing order (counter-clockwise): South's row is pits 0-5
 * (labelled A-F from South's left) and North's row is pits 6-11 (labelled a-f from
 * North's left), as in the sources' diagrams. A pit belongs to the player whose row
 * it is in, unless a round of Nam-nam gave it to the other player (`owners`).
 * Every function is pure: states are never mutated.
 */

export const PIT_COUNT = 12;
export const PITS_PER_SIDE = 6;
export type Player = 0 | 1;
export const SOUTH: Player = 0;
export const NORTH: Player = 1;

export type GrandSlamPolicy = "no-capture" | "forbidden" | "capture-all";
export type RoundStarter = "alternate" | "winner";

export interface OwareConfig {
  seedsPerPit: number;
  /** Abapa: when sowing 12+ seeds, the pit the seeds came from is skipped. */
  skipOrigin: boolean;
  /** Relay sowing (Nam-nam): when the last seed lands in a pit that already held seeds, lift them all and sow on; the move ends in an empty pit. */
  relay: boolean;
  /** Counts that trigger a capture when the last seed lands in an opponent pit. */
  captureCounts: number[];
  /** Also capture preceding opponent pits that hold a capture count. */
  captureChain: boolean;
  /** Counts at which a pit is taken at once by whoever owns it, during anyone's move (Nam-nam: 4). A last seed that makes a capture count in an opponent's pit is the sower's instead. */
  ownerCaptures: number[];
  grandSlam: GrandSlamPolicy;
  /** If the opponent has no seeds when a move begins, the move must leave them at least one. */
  mustFeed: boolean;
  /** A player left with no seeds passes: the other player moves again (and, with mustFeed, must give them seeds). */
  emptyPasses: boolean;
  /** The game ends as soon as a player has captured more than half the seeds, or both have half (Abapa). */
  majority: boolean;
  /** 0 = off. When this many seeds or fewer are left in play, whoever makes the next capture also takes the rest (Nam-nam: 8). */
  lastSeeds: number;
  /** Rounds (Nam-nam): when the seeds run out, each player refills houses from their captures and houses change hands. */
  rounds: boolean;
  /** Who starts the next round: the players take turns (oware.org's Nam-nam rules) or the round's winner (First Step Tours' video). */
  roundStarter: RoundStarter;
  /** 0 = off. Otherwise the game ends when a position (board and player to move) would occur this many times. */
  repetitionLimit: number;
}

export const ABAPA: Readonly<OwareConfig> = Object.freeze({
  seedsPerPit: 4,
  skipOrigin: true,
  relay: false,
  captureCounts: [2, 3],
  captureChain: true,
  ownerCaptures: [],
  grandSlam: "no-capture",
  mustFeed: true,
  emptyPasses: false,
  majority: true,
  lastSeeds: 0,
  rounds: false,
  roundStarter: "alternate",
  repetitionLimit: 0,
});

export const NAMNAM: Readonly<OwareConfig> = Object.freeze({
  seedsPerPit: 4,
  skipOrigin: false,
  relay: true,
  captureCounts: [4],
  captureChain: false,
  ownerCaptures: [4],
  grandSlam: "capture-all",
  mustFeed: true,
  emptyPasses: true,
  majority: false,
  lastSeeds: 8,
  rounds: true,
  roundStarter: "alternate",
  repetitionLimit: 0,
});

export type EndReason = "majority" | "draw" | "no-legal-move" | "repetition" | "agreement" | "territory" | "resignation";

export interface OwareResult {
  winner: Player | null;
  reason: EndReason;
}

export interface RoundResult {
  /** Seeds each player captured in the round. */
  seeds: [number, number];
  /** Houses each player filled from them. */
  houses: [number, number];
}

export interface OwareState {
  pits: readonly number[];
  scores: readonly [number, number];
  toMove: Player;
  /** Plies played. */
  ply: number;
  status: "playing" | "finished";
  result: OwareResult | null;
  /** Occurrence count per position key, for the optional repetition rule. */
  positions: Readonly<Record<string, number>>;
  /** Who owns each pit, when rounds have moved houses between players. Absent: each player owns their own row. */
  owners?: readonly Player[];
  /** The round being played, from 1 (variants with rounds). */
  round?: number;
  /** Who started this round (variants with rounds). */
  starter?: Player;
  /** Earlier rounds, oldest first (variants with rounds). */
  history?: readonly RoundResult[];
}

/** One step of a sowing, for replaying it on the board: lifting a pit's seeds, dropping one, or a capture. */
export interface SowStep {
  pit: number;
  kind: "lift" | "drop" | "capture";
  seeds: number;
  /** Who took the seeds (captures). */
  player?: Player;
}

export type OwareEvent =
  | { type: "sow"; player: Player; pit: number; seeds: number; path: number[]; steps?: SowStep[] }
  | { type: "capture"; player: Player; pits: number[]; seeds: number; whileSowing?: true }
  | { type: "last-seeds"; player: Player; seeds: number }
  | { type: "grand-slam"; player: Player; policy: GrandSlamPolicy; pits: number[] }
  | { type: "sweep"; seeds: [number, number] }
  | { type: "turn"; player: Player }
  | { type: "pass"; player: Player }
  | { type: "round"; round: number; seeds: [number, number]; houses: [number, number]; next: { owners: Player[]; starter: Player } | null }
  | { type: "end"; result: OwareResult; scores: [number, number] };

export function totalSeeds(config: OwareConfig): number {
  return config.seedsPerPit * PIT_COUNT;
}

/** Seeds needed to win: more than half of all seeds (25 of 48 in Abapa). */
export function winThreshold(config: OwareConfig): number {
  return Math.floor(totalSeeds(config) / 2) + 1;
}

/** The player whose row a pit is in. */
export function owner(pit: number): Player {
  return pit < PITS_PER_SIDE ? SOUTH : NORTH;
}

/** Who owns a pit in this position: its row's player, unless a round gave it to the other. */
export function ownerAt(state: Pick<OwareState, "owners">, pit: number): Player {
  return state.owners?.[pit] ?? owner(pit);
}

export function opponent(player: Player): Player {
  return player === SOUTH ? NORTH : SOUTH;
}

/** The pits of a player's row. */
export function sidePits(player: Player): number[] {
  const start = player * PITS_PER_SIDE;
  return [0, 1, 2, 3, 4, 5].map((i) => start + i);
}

/** The pits a player owns in this position (their houses). */
export function ownedPits(state: Pick<OwareState, "owners">, player: Player): number[] {
  return Array.from({ length: PIT_COUNT }, (_, p) => p).filter((p) => ownerAt(state, p) === player);
}

/** Each pit owned by its row's player. */
export function rowOwners(): Player[] {
  return Array.from({ length: PIT_COUNT }, (_, p) => owner(p));
}

/** Seeds in the pits of a player's row. */
export function seedsOnSide(pits: readonly number[], player: Player): number {
  return sidePits(player).reduce((sum, p) => sum + (pits[p] ?? 0), 0);
}

/** Seeds in the pits a player owns. */
export function seedsOwned(pits: readonly number[], owners: readonly Player[] | undefined, player: Player): number {
  return pits.reduce((sum, n, p) => sum + ((owners?.[p] ?? owner(p)) === player ? n : 0), 0);
}

function sum(pits: readonly number[]): number {
  return pits.reduce((a, b) => a + b, 0);
}

export function positionKey(pits: readonly number[], toMove: Player): string {
  return `${toMove}:${pits.join(",")}`;
}

export function createInitialState(config: OwareConfig = ABAPA): OwareState {
  const pits = new Array<number>(PIT_COUNT).fill(config.seedsPerPit);
  const state: OwareState = { pits, scores: [0, 0], toMove: SOUTH, ply: 0, status: "playing", result: null, positions: { [positionKey(pits, SOUTH)]: 1 } };
  return config.rounds ? { ...state, owners: rowOwners(), round: 1, starter: SOUTH, history: [] } : state;
}

export interface SowResult {
  pits: number[];
  lastPit: number;
  path: number[];
}

/** Distribute the seeds of `pit` one by one counter-clockwise, in a single lap (no relay, no captures). */
export function sowPits(pits: readonly number[], pit: number, skipOrigin: boolean): SowResult {
  const next = [...pits];
  let seeds = next[pit] ?? 0;
  next[pit] = 0;
  const path: number[] = [];
  let i = pit;
  while (seeds > 0) {
    i = (i + 1) % PIT_COUNT;
    if (skipOrigin && i === pit) continue;
    next[i] = (next[i] ?? 0) + 1;
    path.push(i);
    seeds -= 1;
  }
  return { pits: next, lastPit: i, path };
}

/** A whole sowing under the variant's settings: relay laps and the captures made while sowing. */
export interface Sowing extends SowResult {
  scores: [number, number];
  steps: SowStep[];
  /** Pits their owners took while the seeds were being sown, in order. */
  captures: { player: Player; pit: number; seeds: number }[];
  /** The rest of the seeds, taken under the last-seeds rule. */
  lastTaken: { player: Player; seeds: number } | null;
  /** Relay sowing that would go round the board for ever. */
  endless: boolean;
}

/** A guard against sowings that never end; real relay sowings stop long before. */
const MAX_DROPS = 5000;

/**
 * Sow from `pit` for `mover`. Seeds drop counter-clockwise (skipping the pit the handful came from when
 * skipOrigin is set). A pit a seed brings to an owner-capture count is taken at once by its owner. With
 * relay sowing, a last seed that lands in a pit that already held seeds lifts them all and sows on. The
 * sowing stops when the last seed lands in an empty pit, makes a capture count in an opponent's pit (the
 * Capture Check takes it), or makes an owner capture; or when the last-seeds rule ends the round.
 */
export function sowMove(pits: readonly number[], scores: readonly [number, number], owners: readonly Player[] | undefined, mover: Player, pit: number, config: OwareConfig): Sowing {
  const next = [...pits];
  const score: [number, number] = [scores[0], scores[1]];
  const ownerOf = (p: number): Player => owners?.[p] ?? owner(p);
  let hand = next[pit] ?? 0;
  next[pit] = 0;
  let origin = pit;
  let at = pit;
  let drops = 0;
  const path: number[] = [];
  const steps: SowStep[] = [{ pit, kind: "lift", seeds: hand }];
  const captures: Sowing["captures"] = [];
  let lastTaken: Sowing["lastTaken"] = null;
  const lifts = new Set<string>();
  const result = (endless: boolean): Sowing => ({ pits: next, scores: score, lastPit: at, path, steps, captures, lastTaken, endless });
  while (hand > 0) {
    at = (at + 1) % PIT_COUNT;
    if (config.skipOrigin && at === origin) continue;
    next[at] = (next[at] ?? 0) + 1;
    hand -= 1;
    drops += 1;
    path.push(at);
    steps.push({ pit: at, kind: "drop", seeds: 1 });
    const count = next[at]!;
    const last = hand === 0;
    if (last && ownerOf(at) !== mover && config.captureCounts.includes(count)) break;
    if (config.ownerCaptures.includes(count)) {
      const taker = ownerOf(at);
      const inPlay = sum(next) + hand;
      next[at] = 0;
      score[taker] += count;
      captures.push({ player: taker, pit: at, seeds: count });
      steps.push({ pit: at, kind: "capture", seeds: count, player: taker });
      if (config.lastSeeds > 0 && inPlay <= config.lastSeeds) {
        const rest = sum(next) + hand;
        if (rest > 0) {
          next.forEach((n, p) => {
            if (n > 0) steps.push({ pit: p, kind: "capture", seeds: n, player: taker });
          });
          next.fill(0);
          hand = 0;
          score[taker] += rest;
          lastTaken = { player: taker, seeds: rest };
        }
        break;
      }
      if (last) break;
      continue;
    }
    if (last && config.relay && count > 1) {
      const key = `${at}:${next.join(",")}`;
      if (lifts.has(key) || drops > MAX_DROPS) return result(true);
      lifts.add(key);
      hand = count;
      next[at] = 0;
      origin = at;
      steps.push({ pit: at, kind: "lift", seeds: count });
    }
  }
  return result(false);
}

export interface CapturePlan {
  pits: number[];
  seeds: number;
  grandSlam: boolean;
}

/** Which pits a last seed in `lastPit` would capture for `mover`, before the grand-slam policy applies. */
export function planCapture(pits: readonly number[], mover: Player, lastPit: number, config: OwareConfig, owners?: readonly Player[]): CapturePlan {
  const ownerOf = (p: number): Player => owners?.[p] ?? owner(p);
  const captured: number[] = [];
  let i = lastPit;
  while (ownerOf(i) !== mover && config.captureCounts.includes(pits[i] ?? 0) && !captured.includes(i)) {
    captured.push(i);
    if (!config.captureChain) break;
    i = (i - 1 + PIT_COUNT) % PIT_COUNT;
  }
  const seeds = captured.reduce((total, p) => total + (pits[p] ?? 0), 0);
  const grandSlam = captured.length > 0 && seeds === seedsOwned(pits, owners, opponent(mover));
  return { pits: captured, seeds, grandSlam };
}

export interface CaptureOutcome {
  pits: number[];
  scores: [number, number];
  captured: number;
  capturedPits: number[];
  grandSlam: boolean;
  /** The rest of the seeds, taken under the last-seeds rule. */
  lastTaken: { player: Player; seeds: number } | null;
}

/** Apply the capture rule (including the grand-slam policy and the last-seeds rule) after the last seed lands in `lastPit`. */
export function resolveCapture(pits: readonly number[], scores: readonly [number, number], mover: Player, lastPit: number, config: OwareConfig, owners?: readonly Player[]): CaptureOutcome {
  const plan = planCapture(pits, mover, lastPit, config, owners);
  const nextScores: [number, number] = [scores[0], scores[1]];
  const nextPits = [...pits];
  // "forbidden" grand slams never reach this point: they are rejected as illegal moves.
  const forfeited = plan.grandSlam && config.grandSlam !== "capture-all";
  if (plan.pits.length === 0 || forfeited) {
    return { pits: nextPits, scores: nextScores, captured: 0, capturedPits: [], grandSlam: plan.grandSlam, lastTaken: null };
  }
  const inPlay = sum(pits);
  for (const p of plan.pits) nextPits[p] = 0;
  nextScores[mover] += plan.seeds;
  let lastTaken: CaptureOutcome["lastTaken"] = null;
  if (config.lastSeeds > 0 && inPlay <= config.lastSeeds) {
    const rest = sum(nextPits);
    if (rest > 0) {
      nextScores[mover] += rest;
      nextPits.fill(0);
      lastTaken = { player: mover, seeds: rest };
    }
  }
  return { pits: nextPits, scores: nextScores, captured: plan.seeds, capturedPits: plan.pits, grandSlam: plan.grandSlam, lastTaken };
}

/** The events a sowing produces, the same whether the engine or a rule graph plays the move. */
export function sowingEvents(mover: Player, pit: number, seeds: number, sown: Sowing, config: OwareConfig): OwareEvent[] {
  const events: OwareEvent[] = [{ type: "sow", player: mover, pit, seeds, path: sown.path, ...(config.relay || config.ownerCaptures.length > 0 ? { steps: sown.steps } : {}) }];
  for (const c of sown.captures) events.push({ type: "capture", player: c.player, pits: [c.pit], seeds: c.seeds, whileSowing: true });
  if (sown.lastTaken) events.push({ type: "last-seeds", player: sown.lastTaken.player, seeds: sown.lastTaken.seeds });
  return events;
}

/** The events of the last seed's capture check. */
export function captureEvents(mover: Player, cap: CaptureOutcome, plan: CapturePlan, config: OwareConfig): OwareEvent[] {
  const events: OwareEvent[] = [];
  if (cap.grandSlam) events.push({ type: "grand-slam", player: mover, policy: config.grandSlam, pits: plan.pits });
  if (cap.captured > 0) events.push({ type: "capture", player: mover, pits: cap.capturedPits, seeds: cap.captured });
  if (cap.lastTaken) events.push({ type: "last-seeds", player: cap.lastTaken.player, seeds: cap.lastTaken.seeds });
  return events;
}

export type IllegalReason = "game-over" | "not-a-pit" | "not-your-pit" | "empty-pit" | "must-feed" | "grand-slam-forbidden" | "endless";

export const ILLEGAL_MESSAGES: Record<IllegalReason, string> = {
  "game-over": "The game is over.",
  "not-a-pit": "Choose one of the twelve pits.",
  "not-your-pit": "You can only sow from your own pits.",
  "empty-pit": "That pit is empty.",
  "must-feed": "Your opponent has no seeds: you must make a move that gives them seeds.",
  "grand-slam-forbidden": "This variant forbids capturing all of your opponent's seeds in one move.",
  endless: "Sowing from this pit would go round the board for ever.",
};

export function checkMove(state: OwareState, pit: number, config: OwareConfig): { legal: true } | { legal: false; reason: IllegalReason } {
  if (state.status !== "playing") return { legal: false, reason: "game-over" };
  if (!Number.isInteger(pit) || pit < 0 || pit >= PIT_COUNT) return { legal: false, reason: "not-a-pit" };
  if (ownerAt(state, pit) !== state.toMove) return { legal: false, reason: "not-your-pit" };
  if ((state.pits[pit] ?? 0) === 0) return { legal: false, reason: "empty-pit" };
  const mover = state.toMove;
  const victim = opponent(mover);
  const sown = sowMove(state.pits, state.scores, state.owners, mover, pit, config);
  if (sown.endless) return { legal: false, reason: "endless" };
  const plan = planCapture(sown.pits, mover, sown.lastPit, config, state.owners);
  if (plan.grandSlam && config.grandSlam === "forbidden") return { legal: false, reason: "grand-slam-forbidden" };
  if (config.mustFeed && seedsOwned(state.pits, state.owners, victim) === 0) {
    const after = resolveCapture(sown.pits, sown.scores, mover, sown.lastPit, config, state.owners);
    // A move that ends the round under the last-seeds rule leaves nobody needing seeds.
    const roundOver = config.lastSeeds > 0 && sum(after.pits) === 0;
    if (!roundOver && seedsOwned(after.pits, state.owners, victim) === 0) return { legal: false, reason: "must-feed" };
  }
  return { legal: true };
}

export function legalMoves(state: OwareState, config: OwareConfig): number[] {
  if (state.status !== "playing") return [];
  return ownedPits(state, state.toMove).filter((p) => checkMove(state, p, config).legal);
}

export type Termination =
  | { outcome: "continue" }
  | { outcome: "again" }
  | { outcome: "round" }
  | { outcome: "win"; winner: Player }
  | { outcome: "draw" }
  | { outcome: "blocked" }
  | { outcome: "cycle" };

/**
 * Evaluated after a move resolves, before the turn passes:
 * with rounds, a board with no seeds left ends the round; with the majority rule, more than half the
 * seeds wins and an even split draws; if the next player cannot move, a player with no seeds passes
 * (emptyPasses: the mover goes again) or the game is blocked; if the optional repetition rule is on and
 * the next position would reach the limit, the game ends.
 */
export function checkTermination(state: OwareState, config: OwareConfig): Termination {
  const mover = state.toMove;
  if (config.rounds && sum(state.pits) === 0) return { outcome: "round" };
  if (config.majority) {
    const threshold = winThreshold(config);
    if (state.scores[mover] >= threshold) return { outcome: "win", winner: mover };
    const rival = opponent(mover);
    if (state.scores[rival] >= threshold) return { outcome: "win", winner: rival };
    const half = totalSeeds(config) / 2;
    if (state.scores[0] === half && state.scores[1] === half) return { outcome: "draw" };
  }
  const other = opponent(mover);
  let next: Player = other;
  if (legalMoves({ ...state, toMove: other }, config).length === 0) {
    if (config.emptyPasses && seedsOwned(state.pits, state.owners, other) === 0 && legalMoves(state, config).length > 0) next = mover;
    else return { outcome: "blocked" };
  }
  if (config.repetitionLimit > 0) {
    const seen = state.positions[positionKey(state.pits, next)] ?? 0;
    if (seen + 1 >= config.repetitionLimit) return { outcome: "cycle" };
  }
  return next === mover ? { outcome: "again" } : { outcome: "continue" };
}

/** Each player captures the seeds remaining in the pits they own. */
export function sweep(state: OwareState): { state: OwareState; seeds: [number, number] } {
  const seeds: [number, number] = [seedsOwned(state.pits, state.owners, SOUTH), seedsOwned(state.pits, state.owners, NORTH)];
  return {
    state: { ...state, pits: new Array<number>(PIT_COUNT).fill(0), scores: [state.scores[0] + seeds[0], state.scores[1] + seeds[1]] },
    seeds,
  };
}

export function finish(state: OwareState, reason: EndReason): OwareState {
  if (reason === "territory") {
    const houses = state.history?.at(-1)?.houses;
    const winner: Player | null = houses ? (houses[0] > houses[1] ? SOUTH : houses[1] > houses[0] ? NORTH : null) : null;
    return { ...state, status: "finished", result: { winner, reason } };
  }
  const [s, n] = state.scores;
  const winner: Player | null = s > n ? SOUTH : n > s ? NORTH : null;
  return { ...state, status: "finished", result: { winner, reason: winner === null && reason === "majority" ? "draw" : reason } };
}

export function passTurn(state: OwareState): OwareState {
  const toMove = opponent(state.toMove);
  const key = positionKey(state.pits, toMove);
  return { ...state, toMove, positions: { ...state.positions, [key]: (state.positions[key] ?? 0) + 1 } };
}

/** The other player has no seeds: the same player moves again. */
export function playAgain(state: OwareState): OwareState {
  const key = positionKey(state.pits, state.toMove);
  return { ...state, positions: { ...state.positions, [key]: (state.positions[key] ?? 0) + 1 } };
}

/**
 * Houses each player fills from their captured seeds, `seedsPerPit` to a house. A house the
 * leftover seeds would have to share goes to the player with more seeds.
 */
export function housesFor(scores: readonly [number, number], config: OwareConfig): [number, number] {
  const houses: [number, number] = [Math.floor(scores[0] / config.seedsPerPit), Math.floor(scores[1] / config.seedsPerPit)];
  const spare = PIT_COUNT - houses[0] - houses[1];
  if (spare > 0) houses[scores[0] >= scores[1] ? 0 : 1] += spare;
  return houses;
}

/**
 * Who owns each pit after a round: each player keeps their own row, and the player with more houses
 * also takes the other row's first pits in sowing order (the ones right after their own row), one per
 * extra house. An even split gives each player their own row back.
 */
export function territories(houses: readonly [number, number]): Player[] {
  const owners = rowOwners();
  if (houses[0] === houses[1]) return owners;
  const winner: Player = houses[0] > houses[1] ? SOUTH : NORTH;
  const loserRow = sidePits(opponent(winner));
  for (let i = 0; i < houses[winner] - PITS_PER_SIDE && i < PITS_PER_SIDE; i++) owners[loserRow[i]!] = winner;
  return owners;
}

/**
 * The round is over (no seeds in play): fill houses from the captures, move houses to the player who
 * won more, and start the next round. The players take turns to start rounds, or (roundStarter
 * "winner") the round's winner starts, and after an even round the player who did not start the last
 * one. `over` when a player has no houses left: the game is won.
 */
export function startNextRound(state: OwareState, config: OwareConfig): { state: OwareState; event: OwareEvent; over: boolean } {
  const seeds: [number, number] = [state.scores[0], state.scores[1]];
  const houses = housesFor(seeds, config);
  const round = state.round ?? 1;
  const history = [...(state.history ?? []), { seeds, houses }];
  if (houses[0] === 0 || houses[1] === 0) {
    return { state: { ...state, history }, event: { type: "round", round, seeds, houses, next: null }, over: true };
  }
  const owners = territories(houses);
  const alternate = opponent(state.starter ?? SOUTH);
  const starter: Player = config.roundStarter === "winner" && houses[0] !== houses[1] ? (houses[0] > houses[1] ? SOUTH : NORTH) : alternate;
  const pits = new Array<number>(PIT_COUNT).fill(config.seedsPerPit);
  return {
    state: { ...state, pits, scores: [0, 0], toMove: starter, owners, round: round + 1, starter, history, positions: { [positionKey(pits, starter)]: 1 } },
    event: { type: "round", round, seeds, houses, next: { owners, starter } },
    over: false,
  };
}

export interface MoveResult {
  legal: boolean;
  reason?: IllegalReason;
  state: OwareState;
  events: OwareEvent[];
}

/** After a round ends (and any sweep), start the next one or, when a player has no houses left, finish. */
function endRound(state: OwareState, config: OwareConfig, events: OwareEvent[]): OwareState {
  const next = startNextRound(state, config);
  events.push(next.event);
  return next.over ? finish(next.state, "territory") : next.state;
}

/** The complete turn: validate, sow, capture, check termination, then pass the turn, start a round or finish. */
export function applyMove(state: OwareState, pit: number, config: OwareConfig = ABAPA): MoveResult {
  const check = checkMove(state, pit, config);
  if (!check.legal) return { legal: false, reason: check.reason, state, events: [] };
  const mover = state.toMove;
  const seeds = state.pits[pit] ?? 0;
  const sown = sowMove(state.pits, state.scores, state.owners, mover, pit, config);
  const events = sowingEvents(mover, pit, seeds, sown, config);
  const plan = planCapture(sown.pits, mover, sown.lastPit, config, state.owners);
  const cap = resolveCapture(sown.pits, sown.scores, mover, sown.lastPit, config, state.owners);
  events.push(...captureEvents(mover, cap, plan, config));
  let next: OwareState = { ...state, pits: cap.pits, scores: cap.scores, ply: state.ply + 1 };
  const end = checkTermination(next, config);
  switch (end.outcome) {
    case "win":
      next = finish(next, "majority");
      break;
    case "draw":
      next = finish(next, "draw");
      break;
    case "blocked":
    case "cycle": {
      const swept = sweep(next);
      events.push({ type: "sweep", seeds: swept.seeds });
      next = config.rounds ? endRound(swept.state, config, events) : finish(swept.state, end.outcome === "blocked" ? "no-legal-move" : "repetition");
      break;
    }
    case "round":
      next = endRound(next, config, events);
      break;
    case "again":
      next = playAgain(next);
      events.push({ type: "pass", player: opponent(mover) });
      break;
    case "continue":
      next = passTurn(next);
      events.push({ type: "turn", player: next.toMove });
      break;
  }
  if (next.status === "finished" && next.result) events.push({ type: "end", result: next.result, scores: [next.scores[0], next.scores[1]] });
  return { legal: true, state: next, events };
}

/**
 * Both players agree the game has become an endless cycle: each takes the seeds in their own pits.
 * With rounds, that ends the round and the next one starts.
 */
export function endByAgreement(state: OwareState, config?: OwareConfig): MoveResult {
  if (state.status !== "playing") return { legal: false, reason: "game-over", state, events: [] };
  const swept = sweep(state);
  const events: OwareEvent[] = [{ type: "sweep", seeds: swept.seeds }];
  const next = config?.rounds ? endRound(swept.state, config, events) : finish(swept.state, "agreement");
  if (next.status === "finished" && next.result) events.push({ type: "end", result: next.result, scores: [next.scores[0], next.scores[1]] });
  return { legal: true, state: next, events };
}

/** A player gives up: the game ends at once and the other player wins. Not a rule of play, so no rule graph runs. */
export function resign(state: OwareState, player: Player): MoveResult {
  if (state.status !== "playing") return { legal: false, reason: "game-over", state, events: [] };
  const next: OwareState = { ...state, status: "finished", result: { winner: opponent(player), reason: "resignation" } };
  return { legal: true, state: next, events: [{ type: "end", result: next.result!, scores: [next.scores[0], next.scores[1]] }] };
}

/** Seeds on the board plus seeds captured; must always equal the starting total. */
export function seedCount(state: OwareState): number {
  return state.pits.reduce((a, b) => a + b, 0) + state.scores[0] + state.scores[1];
}
