/** Angle helpers shared by the map and the 3D view (no three.js here, so the map does not load it). */

/** Compass bearing of (x, z) seen from (cx, cz): 0 north, 90 east. Positive rotation turns clockwise seen from above. */
export function bearing(cx: number, cz: number, x: number, z: number): number {
  return (Math.atan2(x - cx, -(z - cz)) * 180) / Math.PI;
}

/** Keep an angle in [0, 360) with two decimals, as the inspector shows it. */
export function normalizeRotation(r: number): number {
  const n = ((r % 360) + 360) % 360;
  const fixed = Math.round(n * 100) / 100;
  return fixed >= 360 ? 0 : fixed;
}
