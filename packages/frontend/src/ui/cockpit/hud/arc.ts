/**
 * Edge-arc geometry, pure (no React, no store); tested in arc.test.ts.
 * Copied from the spike's CockpitHud arcs (claude/ui-run-spike-c350c8).
 */

/** SVG path of a circular arc from startDeg to endDeg (0° = +x, clockwise). */
export function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const rad = (d: number) => (d * Math.PI) / 180;
  const sx = cx + r * Math.cos(rad(startDeg));
  const sy = cy + r * Math.sin(rad(startDeg));
  const ex = cx + r * Math.cos(rad(endDeg));
  const ey = cy + r * Math.sin(rad(endDeg));
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const sweep = endDeg > startDeg ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${large} ${sweep} ${ex} ${ey}`;
}

/** Angle of tick `i` of `count`, evenly spread from start to end inclusive. */
export function ribAngle(i: number, count: number, start: number, end: number): number {
  return count > 1 ? start + (i / (count - 1)) * (end - start) : (start + end) / 2;
}

/** Splay delay of tick `i`: ripples out from the centre tick. */
export function ribDelayMs(i: number, count: number, stepMs: number): number {
  return Math.abs(i - (count - 1) / 2) * stepMs;
}

/**
 * Angles [upper, lower] of gear segment `i`. Segment 0 sits at the largest
 * angle (the bottom of the curve), so the sweep fills bottom-up as gears rise.
 */
export function gearSegmentAngles(
  i: number,
  count: number,
  start: number,
  end: number,
  gapDeg: number,
): [number, number] {
  const span = (end - start) / count;
  return [end - (i + 1) * span + gapDeg / 2, end - i * span - gapDeg / 2];
}

/** Gauge colour at t ∈ [0,1]: cyan (slow) → amber (fast). Hue only. */
export function gearHue(t: number): string {
  return `oklch(0.85 0.14 ${200 + (55 - 200) * t})`;
}
