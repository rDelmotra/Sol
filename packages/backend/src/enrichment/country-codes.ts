// ============================================================
// Country-code normalization
//
// Three sources, three code systems. The canonical key is the Space-Track
// COUNTRY_CODE (the live authority). This module maps the snapshot vocabularies
// (McDowell SATCAT `state` codes, UCS full country names) onto the canonical
// code. The display-name/flag table (CountryDisplay/COUNTRY_DISPLAY/
// displayCountry) moved to @orbitwatch/contracts's countries.ts in C2a — this
// backend copy had zero importers (grep-verified); only the raw→canonical
// normalizers below are actually consumed (by enrichment ingest).
//
// See my_plans/old/metadata_enrichment.md §3.
// ============================================================

// McDowell GCAT `state` code → canonical Space-Track code.
// (GCAT uses ISO-ish 1–2 letter codes for countries and I-prefixed codes for
// international orgs; Space-Track uses its own set.) Codes NOT in this table
// pass through raw AND are surfaced with counts in gcat-mapping-report.json —
// extend here as the report demands. NOTE: plain 'I' is ITALY (San Marco,
// Sirio); Intelsat is 'I-INT' — an earlier table wrongly sent I→ITSO.
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
  D: 'GER',
  CA: 'CA',
  I: 'IT',       // Italy
  L: 'LUXE',
  KR: 'SKOR',
  E: 'SPN',
  AU: 'AUS',
  IL: 'ISRA',
  TR: 'TURK',
  BR: 'BRAZ',
  AR: 'ARGN',
  NL: 'NETH',
  UAE: 'UAE',
  // International organizations (I-prefixed in GCAT)
  'I-ESA': 'ESA',
  'I-ESRO': 'ESA',   // ESA predecessor
  'I-INT': 'ITSO',   // Intelsat
  'I-EUT': 'EUTE',   // Eutelsat
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
