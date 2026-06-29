// ============================================================
// Country-code normalization
//
// Three sources, three code systems. The canonical key is the Space-Track
// COUNTRY_CODE (the live authority). This module maps the snapshot vocabularies
// (McDowell SATCAT `state` codes, UCS full country names) onto the canonical
// code, and provides a display name + flag emoji for the UI.
//
// The starter table seeds the top spacefaring entities; the long tail falls
// back to the raw code via resolveCountry()/displayCountry(). Finish the tail
// before the country filter ships. See my_plans/metadata_enrichment.md §3.
// ============================================================

export interface CountryDisplay {
  name: string;   // human-readable display name
  flag: string;   // emoji flag (empty for orgs/multinational)
}

// Canonical Space-Track code → display.
export const COUNTRY_DISPLAY: Record<string, CountryDisplay> = {
  US: { name: 'United States', flag: '🇺🇸' },
  PRC: { name: 'China', flag: '🇨🇳' },
  CIS: { name: 'Russia / CIS', flag: '🇷🇺' },
  UK: { name: 'United Kingdom', flag: '🇬🇧' },
  JPN: { name: 'Japan', flag: '🇯🇵' },
  IND: { name: 'India', flag: '🇮🇳' },
  FR: { name: 'France', flag: '🇫🇷' },
  GER: { name: 'Germany', flag: '🇩🇪' },
  ITSO: { name: 'Intelsat', flag: '' },
  ESA: { name: 'ESA', flag: '🇪🇺' },
  EUTE: { name: 'Eutelsat', flag: '' },
  SES: { name: 'SES (Luxembourg)', flag: '🇱🇺' },
  CA: { name: 'Canada', flag: '🇨🇦' },
  SKOR: { name: 'South Korea', flag: '🇰🇷' },
  SPN: { name: 'Spain', flag: '🇪🇸' },
  AUS: { name: 'Australia', flag: '🇦🇺' },
  ISRA: { name: 'Israel', flag: '🇮🇱' },
  TURK: { name: 'Turkey', flag: '🇹🇷' },
  BRAZ: { name: 'Brazil', flag: '🇧🇷' },
  ARGN: { name: 'Argentina', flag: '🇦🇷' },
  NETH: { name: 'Netherlands', flag: '🇳🇱' },
  LUXE: { name: 'Luxembourg', flag: '🇱🇺' },
  GLOB: { name: 'Multinational', flag: '🌐' },
  NZ: { name: 'New Zealand', flag: '🇳🇿' },
  TBD: { name: 'Unknown', flag: '' },
};

// McDowell SATCAT `state` code → canonical Space-Track code.
// (SATCAT uses ISO-ish 1–2 letter codes; Space-Track uses its own set.)
export const SATCAT_STATE_TO_CANONICAL: Record<string, string> = {
  US: 'US',
  SU: 'CIS',  // Soviet Union → CIS/Russia lineage
  RU: 'CIS',
  CN: 'PRC',
  F: 'FR',
  J: 'JPN',
  UK: 'UK',
  IN: 'IND',
  NZ: 'NZ',
  'I-ESA': 'ESA',
  D: 'GER',
  CA: 'CA',
  I: 'ITSO',  // Intelsat (org)
  L: 'LUXE',
  KR: 'SKOR',
  E: 'SPN',
  AU: 'AUS',
  IL: 'ISRA',
  TR: 'TURK',
};

// UCS full country name → canonical Space-Track code.
export const UCS_COUNTRY_TO_CANONICAL: Record<string, string> = {
  USA: 'US',
  China: 'PRC',
  Russia: 'CIS',
  'United Kingdom': 'UK',
  Japan: 'JPN',
  India: 'IND',
  France: 'FR',
  Germany: 'GER',
  Canada: 'CA',
  'South Korea': 'SKOR',
  Spain: 'SPN',
  Australia: 'AUS',
  Israel: 'ISRA',
  Turkey: 'TURK',
  Brazil: 'BRAZ',
  Argentina: 'ARGN',
  Netherlands: 'NETH',
  Luxembourg: 'LUXE',
  Multinational: 'GLOB',
  ESA: 'ESA',
  'New Zealand': 'NZ',
};

/** Resolve a SATCAT `state` code to canonical; pass through unknowns. */
export function canonicalFromSatcatState(state: string): string {
  return SATCAT_STATE_TO_CANONICAL[state] ?? state;
}

/** Resolve a UCS country name to canonical; pass through unknowns. */
export function canonicalFromUcsCountry(name: string): string {
  return UCS_COUNTRY_TO_CANONICAL[name.trim()] ?? name.trim();
}

/** Display name for a canonical code; falls back to the raw code. */
export function displayCountry(code: string | null): string {
  if (!code) return 'Unknown';
  return COUNTRY_DISPLAY[code]?.name ?? code;
}
