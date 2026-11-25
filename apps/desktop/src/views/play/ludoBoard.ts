import { HOME, LAST_TRACK, YARD } from "@gamestudio/ludo";

/** Grid cell [row, column] on the 15 x 15 board. */
export type Cell = [number, number];

/**
 * The 52 main-track squares, clockwise from Red's start square (index 0). Seat s starts at index 13 * s,
 * matching squareOf() in the engine. Red's yard is top left, Green's top right, Yellow's bottom right, Blue's bottom left.
 */
export const TRACK_CELLS: Cell[] = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
  [0, 7],
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
  [7, 14],
  [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
  [14, 7],
  [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  [7, 0],
  [6, 0],
];

/** Each seat's five home-column squares, in the order a token climbs them. */
export const HOME_COLUMNS: Cell[][] = [
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
];

const YARD_ORIGINS: Cell[] = [[0, 0], [0, 9], [9, 9], [9, 0]];
export const SEAT_COLOURS = ["#e5534b", "#3fb950", "#e3b341", "#4c8eda"];

/** Where a token is drawn: fractional [row, column] of its centre. */
export function tokenCell(seat: number, progress: number, token: number): [number, number] {
  if (progress === YARD) {
    const [r, c] = YARD_ORIGINS[seat]!;
    return [r + 1.5 + 2 * Math.floor(token / 2), c + 1.5 + 2 * (token % 2)];
  }
  if (progress === HOME) {
    const spread: [number, number][] = [[-0.35, -0.35], [-0.35, 0.35], [0.35, -0.35], [0.35, 0.35]];
    const toward: [number, number][] = [[0, -0.55], [-0.55, 0], [0, 0.55], [0.55, 0]];
    return [7 + 0.5 + toward[seat]![0] + spread[token]![0] * 0.5, 7 + 0.5 + toward[seat]![1] + spread[token]![1] * 0.5];
  }
  const [r, c] = progress <= LAST_TRACK ? TRACK_CELLS[(seat * 13 + progress) % 52]! : HOME_COLUMNS[seat]![progress - LAST_TRACK - 1]!;
  return [r + 0.5, c + 0.5];
}

/** The colour a board cell is painted: a seat's yard, home column or start square, the centre, or plain track. */
export function cellPaint(row: number, col: number): { kind: "yard" | "home" | "start" | "centre" | "track" | "none"; seat?: number } {
  for (let s = 0; s < 4; s++) {
    const [r, c] = YARD_ORIGINS[s]!;
    if (row >= r && row < r + 6 && col >= c && col < c + 6) return { kind: "yard", seat: s };
    if (HOME_COLUMNS[s]!.some(([hr, hc]) => hr === row && hc === col)) return { kind: "home", seat: s };
    const [sr, sc] = TRACK_CELLS[s * 13]!;
    if (sr === row && sc === col) return { kind: "start", seat: s };
  }
  if (row >= 6 && row <= 8 && col >= 6 && col <= 8) return { kind: "centre" };
  if (TRACK_CELLS.some(([r, c]) => r === row && c === col)) return { kind: "track" };
  return { kind: "none" };
}
