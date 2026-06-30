// ============================================================
// Country display — frontend mirror of backend enrichment/country-codes.ts.
//
// Maps canonical Space-Track operator codes → a display name + flag emoji for the
// country filter list and (Phase C) the InfoCard. The long tail falls back to the
// raw code with no flag. Pure data tier.
// ============================================================

export interface CountryDisplay {
  name: string;
  flag: string;
}

export const COUNTRY_DISPLAY: Record<string, CountryDisplay> = {
  US:   { name: 'United States', flag: '🇺🇸' },
  PRC:  { name: 'China', flag: '🇨🇳' },
  CIS:  { name: 'Russia / CIS', flag: '🇷🇺' },
  UK:   { name: 'United Kingdom', flag: '🇬🇧' },
  JPN:  { name: 'Japan', flag: '🇯🇵' },
  IND:  { name: 'India', flag: '🇮🇳' },
  FR:   { name: 'France', flag: '🇫🇷' },
  GER:  { name: 'Germany', flag: '🇩🇪' },
  ITSO: { name: 'Intelsat', flag: '🛰️' },
  ESA:  { name: 'ESA', flag: '🇪🇺' },
  EUTE: { name: 'Eutelsat', flag: '🛰️' },
  SES:  { name: 'SES (Luxembourg)', flag: '🇱🇺' },
  CA:   { name: 'Canada', flag: '🇨🇦' },
  SKOR: { name: 'South Korea', flag: '🇰🇷' },
  SPN:  { name: 'Spain', flag: '🇪🇸' },
  AUS:  { name: 'Australia', flag: '🇦🇺' },
  ISRA: { name: 'Israel', flag: '🇮🇱' },
  TURK: { name: 'Turkey', flag: '🇹🇷' },
  BRAZ: { name: 'Brazil', flag: '🇧🇷' },
  ARGN: { name: 'Argentina', flag: '🇦🇷' },
  NETH: { name: 'Netherlands', flag: '🇳🇱' },
  LUXE: { name: 'Luxembourg', flag: '🇱🇺' },
  GLOB: { name: 'Multinational', flag: '🌐' },
  NZ:   { name: 'New Zealand', flag: '🇳🇿' },
  TBD:  { name: 'Unknown', flag: '🏳️' },
};

/** Display name for a canonical code; falls back to the raw code. */
export function displayCountry(code: string): string {
  return COUNTRY_DISPLAY[code]?.name ?? code;
}

/** Flag emoji for a canonical code; empty string when unknown. */
export function countryFlag(code: string): string {
  return COUNTRY_DISPLAY[code]?.flag ?? '';
}
