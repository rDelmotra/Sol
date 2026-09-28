// ============================================================
// vocab.ts — GCAT code → canonical enum normalization tables
//
// Every table is EXHAUSTIVE over the codes observed in the 2026-07-03 snapshot
// and doc-verified against the official GCAT documentation:
//   Status codes:  https://planet4589.org/space/gcat/web/intro/phases.html
//   psatcat cols:  https://planet4589.org/space/gcat/web/cat/pcols.html
//   satcat cols:   https://planet4589.org/space/gcat/web/cat/cols.html
//
// Lookups return `undefined` for unknown codes — callers map that to the
// 'unknown' bucket AND count it in the build's gcat-mapping-report.json.
// Nothing is ever folded silently; raw codes are preserved per record in the
// ObjectMetadata.gcat block, so every mapping here is reversible.
//
// Deliberate folds (user decisions, 2026-07-06):
//   Status 'L' (Landed, ~1,074 objects)      → 'deorbited' (promote later if wanted)
//   Clas 'A' (amateur/academic, ~963)        → 'civil'
// ============================================================

import type { AnalyticObjectType, OrbitalStatus, Purpose, Sector } from '@orbitwatch/contracts';

// ── satcat Status → OrbitalStatus ─────────────────────────────────────────────
// Doc-verified; grouped by outcome family. Attached-variant codes (A-prefixed)
// share their base code's fate. 'N' = Renamed — the record was superseded by a
// successor JCAT, but the object itself is still in orbit (the NORAD dedupe in
// ingest.ts prefers the successor row when both share a NORAD).
export const GCAT_STATUS_TO_ORBITAL: Record<string, OrbitalStatus> = {
  // in orbit (free-flying, attached, docked, or lost-but-orbiting)
  O: 'in_orbit',
  AO: 'in_orbit',
  'AO IN': 'in_orbit',
  OX: 'in_orbit',      // in orbit (probably) but lost — no recent tracking
  DK: 'in_orbit',      // docked
  GRP: 'in_orbit',     // grappled
  ATT: 'in_orbit',     // attached
  TFR: 'in_orbit',     // internal transfer between compartments
  'TFR E': 'in_orbit',
  'TFR IN': 'in_orbit',
  REL: 'in_orbit',     // released from attached parent
  'EVA DP': 'in_orbit',
  N: 'in_orbit',       // renamed while in orbit (superseded record)
  NA: 'in_orbit',      // renamed while attached

  // decayed (natural/uncontrolled reentry)
  R: 'decayed',
  AR: 'decayed',
  'AR IN': 'decayed',
  AS: 'decayed',       // suborbital reentry while attached

  // deorbited (active return: deorbit burn, targeted entry, intact landing)
  D: 'deorbited',
  L: 'deorbited',      // Landed — folded per user decision; raw 'L' preserved
  LF: 'deorbited',     // failed landing
  AL: 'deorbited',
  'AL IN': 'deorbited',
  S: 'deorbited',      // targeted suborbital entry at mission end
  TX: 'deorbited',     // operated on surface, transmission ended

  // beyond Earth (deep space / escaped / around another body)
  DSO: 'beyond_earth',
  DSA: 'beyond_earth',
  'DSA IN': 'beyond_earth',
  EO: 'beyond_earth',  // escaped sphere of influence
  EAO: 'beyond_earth',
  EN: 'beyond_earth',  // planetary flyby then escape
  LO: 'beyond_earth',  // liftoff from another world
  OI: 'beyond_earth',  // orbit insertion at another body
  OE: 'beyond_earth',  // orbit escape burn

  // destroyed in orbit
  E: 'exploded',
  C: 'exploded',       // collided → destroyed

  // no real object — also excluded from the decayed browser by ingest
  ERR: 'unknown',
};

/** Status lookup; strips ONE trailing '?' ("R?" → "R"). undefined = unmapped. */
export function lookupGcatStatus(code: string | null): OrbitalStatus | undefined {
  if (!code) return undefined;
  const key = code.endsWith('?') ? code.slice(0, -1).trim() : code;
  return GCAT_STATUS_TO_ORBITAL[key];
}

// ── satcat Type (first char) → AnalyticObjectType ─────────────────────────────
// Later chars are attribute flags (docked/human-related/…) — the whole cell is
// preserved raw in ObjectMetadata.gcat.type. 'Z' = spurious entry (26 rows in
// this snapshot): kept as 'unknown' + reported.
const TYPE_FIRST_CHAR: Record<string, AnalyticObjectType> = {
  P: 'payload',
  R: 'rocket_body',
  C: 'component',
  D: 'debris',
  Z: 'unknown',
};

/** Type lookup on the first character. undefined = unmapped first char. */
export function lookupGcatType(type: string | null): AnalyticObjectType | undefined {
  if (!type) return undefined;
  return TYPE_FIRST_CHAR[type[0]];
}

// ── psatcat Clas (per char) → Sector[] ────────────────────────────────────────
// Multi-char = shared management (e.g. 'BD' → commercial + military).
const CLAS_CHAR_TO_SECTOR: Record<string, Sector> = {
  B: 'commercial',
  D: 'military',
  C: 'civil',
  A: 'civil',          // amateur/academic — folded per user decision; raw preserved
};

export interface ClasMapping {
  sectors: Sector[];
  unknownChars: string[];
}

/** Map every char of a Clas cell; dedupe; unknown chars surface for the report. */
export function clasToSectors(clas: string | null): ClasMapping {
  const sectors: Sector[] = [];
  const unknownChars: string[] = [];
  for (const ch of clas ?? '') {
    const s = CLAS_CHAR_TO_SECTOR[ch];
    if (!s) unknownChars.push(ch);
    else if (!sectors.includes(s)) sectors.push(s);
  }
  return { sectors, unknownChars };
}

// ── psatcat Category → Purpose ────────────────────────────────────────────────
// Cell grammar: one or two slash-separated tokens, optional '?' (uncertain) and
// '*' (historically classified orbit) flags. Primary token decides the Purpose;
// the full raw cell goes to detailedPurpose / the gcat raw block.
const CATEGORY_PRIMARY_TO_PURPOSE: Record<string, Purpose> = {
  COM: 'communications',
  IMG: 'earth_observation',
  'IMG-R': 'earth_observation',   // radar imaging
  NAV: 'navigation',
  TECH: 'technology_dev',
  CAL: 'technology_dev',          // calibration targets
  SCI: 'space_science',
  EOSCI: 'space_science',         // earth-oriented science
  GEOD: 'space_science',          // geodesy
  MGRAV: 'space_science',         // microgravity
  BIO: 'space_science',
  EDU: 'space_science',
  AST: 'space_observation',
  SIG: 'surveillance',            // signals intelligence
  EW: 'surveillance',             // early warning
  MET: 'meteorological',
  'MET-RO': 'meteorological',     // radio-occultation weather
  // explicit 'other' buckets — mapped (NOT unmapped) so the report stays clean
  SS: 'other',                    // space station / spaceship
  PLAN: 'other',                  // deep-space / planetary
  WEAPON: 'other',
  TARG: 'other',
  RV: 'other',                    // reentry vehicle
  MISC: 'other',
  INF: 'other',                   // infrastructure
};

/**
 * Category lookup: strip '?'/'*' flags, take the primary (pre-'/') token.
 * undefined = primary token not in the table (reported, mapped to 'other').
 */
export function categoryToPurpose(category: string | null): Purpose | undefined {
  if (!category) return undefined;
  const primary = category.split('/')[0]?.replace(/[?*]/g, '').trim() ?? '';
  if (!primary) return undefined;
  return CATEGORY_PRIMARY_TO_PURPOSE[primary];
}
