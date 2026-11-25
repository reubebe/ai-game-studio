import { describe, expect, it } from "vitest";
import { HOME, squareOf } from "@gamestudio/ludo";
import { cellPaint, HOME_COLUMNS, TRACK_CELLS, tokenCell } from "./ludoBoard";

describe("Ludo board layout", () => {
  it("has 52 distinct track squares, each next to the one before", () => {
    expect(TRACK_CELLS).toHaveLength(52);
    expect(new Set(TRACK_CELLS.map((c) => c.join(","))).size).toBe(52);
    TRACK_CELLS.forEach(([r, c], i) => {
      const [pr, pc] = TRACK_CELLS[(i + 51) % 52]!;
      expect(Math.abs(r - pr) + Math.abs(c - pc), `square ${i}`).toBeLessThanOrEqual(2);
      expect(Math.max(Math.abs(r - pr), Math.abs(c - pc)), `square ${i}`).toBe(1);
    });
  });

  it("puts each seat's start square on its own arm and its home column next to its last track square", () => {
    for (let seat = 0; seat < 4; seat++) {
      expect(cellPaint(...TRACK_CELLS[squareOf(seat, 0)!]!)).toEqual({ kind: "start", seat });
      const [lr, lc] = TRACK_CELLS[squareOf(seat, 50)!]!;
      const [hr, hc] = HOME_COLUMNS[seat]![0]!;
      expect(Math.abs(lr - hr) + Math.abs(lc - hc)).toBe(1);
      const [r, c] = tokenCell(seat, HOME, 0);
      expect(r > 6 && r < 9 && c > 6 && c < 9).toBe(true);
    }
  });
});
