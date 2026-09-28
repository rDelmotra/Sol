// ============================================================
// Facet color palettes — the SINGLE source of truth for object coloring.
//
// Shared by the globe (engine/SatelliteRenderer writes these into the GL color
// buffer) and the UI (ui/FilterPanel shows them as swatches on the active
// color-by group, which doubles as the legend). One module → globe and legend
// can never drift. Pure data tier: no engine/UI imports.
// ============================================================

import type { CatalogType } from './types';
import type { Sector, OrbitalStatus } from '@orbitwatch/contracts';
import type { SectorFilterKey } from './metadata-types';

export type RGB = [number, number, number];

export const FALLBACK_GREY: RGB = [0.459, 0.459, 0.459];

export const TYPE_COLORS: Record<CatalogType, RGB> = {
  satellite:   [0.298, 0.686, 0.314], // payload — green
  rocket_body: [1.000, 0.757, 0.027], // amber
  debris:      [0.957, 0.263, 0.212], // red
  unknown:     [0.459, 0.459, 0.459], // grey
  deep_space:  [0.000, 0.737, 0.831], // cyan
};

export const STATUS_COLORS: Record<OrbitalStatus, RGB> = {
  in_orbit:     [0.298, 0.686, 0.314], // green
  decayed:      [0.957, 0.263, 0.212], // red
  deorbited:    [0.851, 0.325, 0.310], // muted red
  beyond_earth: [0.612, 0.404, 0.910], // violet
  exploded:     [1.000, 0.498, 0.063], // orange
  unknown:      [0.459, 0.459, 0.459], // grey
};

export const SECTOR_COLORS: Record<SectorFilterKey, RGB> = {
  commercial:  [0.129, 0.588, 0.953], // blue
  government:  [0.298, 0.686, 0.314], // green
  military:    [0.906, 0.298, 0.235], // red
  civil:       [0.000, 0.737, 0.831], // teal
  unspecified: [0.459, 0.459, 0.459], // grey
};

// Distinct hues for the biggest operators (canonical Space-Track codes); everyone
// else falls back to grey. Keep in sync with backend enrichment/country-codes.ts.
export const COUNTRY_COLORS: Record<string, RGB> = {
  US:   [0.129, 0.588, 0.953], // blue
  PRC:  [0.906, 0.298, 0.235], // red
  CIS:  [1.000, 0.596, 0.000], // orange
  UK:   [0.612, 0.404, 0.910], // violet
  JPN:  [0.926, 0.404, 0.631], // pink
  IND:  [0.298, 0.686, 0.314], // green
  FR:   [0.000, 0.737, 0.831], // cyan
  GER:  [1.000, 0.851, 0.235], // yellow
  ESA:  [0.404, 0.792, 0.643], // sea green
  CA:   [0.847, 0.482, 0.863], // orchid
  SES:  [0.561, 0.690, 0.196], // olive
  ITSO: [0.498, 0.549, 0.612], // slate
};

/** Sector color, picking the primary (first) sector; 'unspecified' grey when none. */
export function sectorColor(sectors: Sector[]): RGB {
  return sectors.length > 0 ? (SECTOR_COLORS[sectors[0]] ?? FALLBACK_GREY) : SECTOR_COLORS.unspecified;
}

/** RGB [0..1] tuple → CSS `rgb(...)` string for swatches. */
export function rgbToCss(rgb: RGB): string {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}
