/**
 * Compass-strip geometry, pure (no React, no store); tested in compass.test.ts.
 * From the spike's ui/CompassStrip.tsx (d1a0c70).
 */
import type { Pass } from '../../../sky/passes';

/** Degrees of azimuth the strip spans edge to edge. */
export const VISIBLE_SPAN_DEG = 140;
/** Letters at the 8 compass points; every other 15° is a plain tick. */
export const POINT_LABELS: Record<number, string> = {
  0: 'N',
  45: 'NE',
  90: 'E',
  135: 'SE',
  180: 'S',
  225: 'SW',
  270: 'W',
  315: 'NW',
};

/** Shortest signed angular difference, wrapped to [-180, 180]. */
export function wrapDelta(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Azimuth to on-strip position (percent of strip width), or null outside the
 * visible span. Shared by heading ticks and pass markers so both agree on what
 * is on screen.
 */
export function spanPosition(azimuthDeg: number, headingDeg: number): number | null {
  const delta = wrapDelta(azimuthDeg - headingDeg);
  if (Math.abs(delta) > VISIBLE_SPAN_DEG / 2) return null;
  return 50 + (delta / VISIBLE_SPAN_DEG) * 100;
}

export interface Tick {
  deg: number;
  xPct: number;
  label?: string;
  major: boolean;
}

/** Ticks every 15° that fall inside the visible span. */
export function visibleTicks(headingDeg: number): Tick[] {
  const out: Tick[] = [];
  for (let a = 0; a < 360; a += 15) {
    const xPct = spanPosition(a, headingDeg);
    if (xPct !== null) out.push({ deg: a, xPct, label: POINT_LABELS[a], major: a % 45 === 0 });
  }
  return out;
}

/** A rise or set marker: on the strip, or an arrow at the edge it lies past. */
export type EdgeMark = { kind: 'on'; xPct: number } | { kind: 'off'; side: 'left' | 'right' } | null;

export function edgeMark(azimuthDeg: number | null, headingDeg: number): EdgeMark {
  if (azimuthDeg === null) return null;
  const xPct = spanPosition(azimuthDeg, headingDeg);
  if (xPct !== null) return { kind: 'on', xPct };
  return { kind: 'off', side: wrapDelta(azimuthDeg - headingDeg) < 0 ? 'left' : 'right' };
}

/**
 * Where the object comes up and goes down, as bearings on the horizon. A
 * clipped end has no real crossing (it is the edge of the search window), so
 * it gets no marker. `azimuthAt` gives the azimuth at a time (null if it
 * cannot); the 0° crossing is used, falling back to the stored 10° bearing.
 */
export function riseSetBearings(
  pass: Pass | null,
  azimuthAt: (ms: number) => number | null,
): { rise: number | null; set: number | null } {
  if (!pass) return { rise: null, set: null };
  return {
    rise: pass.startClipped ? null : (azimuthAt(pass.horizonAosMs) ?? pass.aosAzimuthDeg),
    set: pass.endClipped ? null : (azimuthAt(pass.horizonLosMs) ?? pass.losAzimuthDeg),
  };
}
