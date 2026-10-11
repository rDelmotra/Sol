/**
 * Pure helpers for the gamepad reticle area pick (no three.js, no GL), so the
 * circle test and the ranking can be unit-tested. GPUPicker.pickAreaRadius
 * reads the pick target and feeds the pixels through these.
 */

/**
 * Width of one camera-distance band, in ln(distance²) units. ln(1.1)·2 ≈ 0.19:
 * objects within ~10% relative depth share a band and are then ordered by how
 * near the crosshair they are. Raw float distances never tie, so without bands
 * "nearest the crosshair" would never decide anything.
 */
export const CAM_DISTANCE_BAND = 0.19;

/**
 * True when a pick-target pixel offset lies inside a circle of `radiusPx` CSS
 * pixels. The pick target is a fixed square (e.g. 512²) stretched over a
 * non-square canvas, so x and y scale differently: a circle on screen is an
 * ellipse in pick pixels. `scaleX` / `scaleY` are pick-pixels per CSS pixel.
 * Returns the squared CSS-pixel distance, or -1 when outside.
 */
export function cssDistSqInCircle(
  dxPick: number,
  dyPick: number,
  scaleX: number,
  scaleY: number,
  radiusPx: number,
): number {
  const dx = dxPick / scaleX;
  const dy = dyPick / scaleY;
  const d2 = dx * dx + dy * dy;
  return d2 <= radiusPx * radiusPx ? d2 : -1;
}

/**
 * Rank reticle hits: nearest the camera first (in {@link CAM_DISTANCE_BAND}
 * bands), then nearest the crosshair. `closestDistSq` maps each hit index to its
 * closest pixel's squared CSS-pixel distance from the centre.
 */
export function rankReticleHits(
  closestDistSq: Map<number, number>,
  camDistSqOf: (index: number) => number,
): number[] {
  const band = new Map<number, number>();
  for (const i of closestDistSq.keys()) {
    band.set(i, Math.round(Math.log(camDistSqOf(i) + 1e-12) / CAM_DISTANCE_BAND));
  }
  return Array.from(closestDistSq.keys()).sort((a, b) => {
    const byCamera = band.get(a)! - band.get(b)!;
    return byCamera !== 0 ? byCamera : closestDistSq.get(a)! - closestDistSq.get(b)!;
  });
}
