// ============================================================
// @orbitwatch/contracts — countries.ts
//
// Country display (name + flag emoji) for canonical Space-Track operator
// codes. Step C2a of PROJECT_MAP/15_ORBITAL_CORE_AND_CONTRACTS.md — values
// taken from frontend `data/country-codes.ts` (the version actually shown to
// users today). Backend `enrichment/country-codes.ts` carried a second,
// independently-maintained copy of this table with ZERO importers (verified
// by grep) — its flag values differ from the frontend's for three codes
// (ITSO, EUTE, TBD; see the C2a report for the exact diff). Since nothing
// ever read the backend copy, adopting the frontend's values here changes no
// runtime behavior. The backend's `canonicalFromSatcatState`/
// `canonicalFromUcsCountry` normalizers + their source-vocab maps stay
// package-local (build-time ingest helpers, not a wire/display shape).
// ============================================================

export interface CountryDisplay {
  name: string;   // human-readable display name
  flag: string;   // emoji flag (empty for orgs/multinational)
}

// Canonical Space-Track code → display.
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
  IT:   { name: 'Italy', flag: '🇮🇹' },
  UAE:  { name: 'United Arab Emirates', flag: '🇦🇪' },
  GLOB: { name: 'Multinational', flag: '🌐' },
  NZ:   { name: 'New Zealand', flag: '🇳🇿' },
  TBD:  { name: 'Unknown', flag: '🏳️' },
};

/** Display name for a canonical code; falls back to the raw code. */
export function displayCountry(code: string | null): string {
  if (!code) return 'Unknown';
  return COUNTRY_DISPLAY[code]?.name ?? code;
}

/** Flag emoji for a canonical code; empty string when unknown. */
export function countryFlag(code: string | null): string {
  if (!code) return '';
  return COUNTRY_DISPLAY[code]?.flag ?? '';
}
