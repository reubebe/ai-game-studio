import { matchingMaps, type World } from "@gamestudio/explore";

/** A ground material for a colour texture, with the normal and roughness maps that come with it. */
export function guessMaterial(albedo: string, textures: string[], tile: number): NonNullable<World["environment"]["groundMaterial"]> {
  return { albedo, tile, ...matchingMaps(albedo, textures) };
}
