import { describe, expect, it } from "vitest";
import { guessMaterial } from "./textures";

describe("ground texture sets", () => {
  it("finds the normal and roughness maps that come with a colour texture", () => {
    const files = [
      "assets/textures/aerial_rocks_02/aerial_rocks_02_diff_1k.jpg",
      "assets/textures/aerial_rocks_02/aerial_rocks_02_nor_gl_1k.jpg",
      "assets/textures/aerial_rocks_02/aerial_rocks_02_rough_1k.jpg",
      "assets/textures/grass/grass_diff_1k.jpg",
    ];
    expect(guessMaterial(files[0]!, files, 4)).toEqual({ albedo: files[0], normal: files[1], roughness: files[2], tile: 4 });
    expect(guessMaterial(files[3]!, files, 2)).toEqual({ albedo: files[3], tile: 2 });
    expect(guessMaterial("assets/textures/stone.png", ["assets/textures/stone.png", "assets/textures/stone_normal.png"], 4)).toEqual({ albedo: "assets/textures/stone.png", tile: 4 });
  });
});
