/**
 * Object-disc geometry and field text, pure (no React, no store); tested in
 * disc.test.ts. Copied from the spike's ui/ObjectDisc.tsx (d1a0c70), with the
 * honest altitude / speed rules of format.ts.
 */
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { altitudeLabel, altitudeReading, degStr, elementOrbit, finite, kmStr, minStr, velStr } from './format';

/** Ring radius as a share of min(width, height). */
export const DISC_FRAC = 0.26;
/** Bright sector centres, degrees clockwise from 12 o'clock (right side). */
export const PRIMARY_ANGLES = [36, 58, 80] as const;
/** Dim sector centres (left side). */
export const SECONDARY_ANGLES = [214, 230, 246, 262, 278, 294] as const;
/** Half-width of every sector, degrees. */
export const SECTOR_HALF_DEG = 11;
/** Ticks around the ring (every 5°); every 6th is a major tick. */
export const TICK_COUNT = 72;

export interface Pt {
  x: number;
  y: number;
}
export interface DiscItem {
  k: string;
  v: string;
}

/** Point at `r` px from `C`, `deg` clockwise from 12 o'clock. */
export function polar(C: Pt, r: number, deg: number): Pt {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) };
}

/** SVG path of the sector from a0 to a1 degrees (clockwise from 12 o'clock). */
export function sectorPath(C: Pt, r: number, a0: number, a1: number): string {
  const s = polar(C, r, a1);
  const e = polar(C, r, a0);
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${a1 - a0 <= 180 ? 0 : 1} 0 ${e.x} ${e.y}`;
}

/** Ring radius, px, for a HUD of this size. */
export function discRadius(w: number, h: number): number {
  return Math.min(w, h) * DISC_FRAC;
}

/** Underscores to spaces, upper case; a dash for nothing. */
export function upperText(s: string | null | undefined): string {
  return s ? s.replace(/_/g, ' ').toUpperCase() : '—';
}

/**
 * The nine fields. ALTITUDE is the live SGP4 altitude; without it the row says
 * MEAN ALT (the elements' mean) and is never unlabelled. VELOCITY only when
 * live, else a dash. Same sources and formatters as the TELEMETRY pane.
 */
export function discItems(
  o: EnrichedTLEObject,
  liveAltKm: number | null,
  liveSpeedKmS: number | null,
): { primary: DiscItem[]; secondary: DiscItem[] } {
  const orbit = elementOrbit(o);
  const alt = altitudeReading(liveAltKm, orbit.meanAltKm);
  const speed = finite(liveSpeedKmS) ? velStr(liveSpeedKmS) : '—';
  return {
    primary: [
      { k: altitudeLabel(alt), v: kmStr(alt?.km).toLowerCase() },
      { k: 'VELOCITY', v: speed.toLowerCase() },
      { k: 'ROLE', v: upperText(o.purpose) },
    ],
    secondary: [
      // Listed bottom-up: the dim arcs run 214°→294°, so the first item lands
      // lowest on screen and COUNTRY ends on top, as in the approved spike.
      { k: 'NORAD', v: String(o.noradId) },
      { k: 'INCL', v: degStr(orbit.inclination) },
      { k: 'PERIOD', v: minStr(orbit.period).toLowerCase() },
      { k: 'RCS', v: upperText(o.rcsSize) },
      { k: 'LAUNCHED', v: o.launchDate ?? '—' },
      { k: 'COUNTRY', v: o.countryCode || '—' },
    ],
  };
}
