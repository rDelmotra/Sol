// ============================================================
// Query IR — the stable contract of the search-first query layer.
//
// Any compiler produces a QueryIR; one executor consumes it. Today the only
// compiler is the local token parser (parser.ts); a future backend LLM
// compiler (natural language → same IR) plugs in without touching the
// executor or store wiring.
//
// Tier rule: src/query/* imports ONLY from src/data/* — never store/ or
// engine/ — so everything here runs under plain node:test and can be reused
// as the response type of a future POST /api/query/compile.
// ============================================================

import type { CatalogType, OrbitalRegime } from '../data/types';
import type { Purpose, SectorFilterKey, OrbitalStatus } from '../data/metadata-types';

export type FacetGroup =
  | 'type'
  | 'status'
  | 'sector'
  | 'purpose'
  | 'regime'
  | 'country'
  | 'program'
  // ── G3 launch-graph facets ──────────────────────────────────────────────────
  // vehicle/site/launch/launch_year all COMPILE DOWN to a launch-tag set in the
  // executor (see launchFilter); owner is its own org-code set.
  | 'vehicle'
  | 'site'
  | 'launch'
  | 'launch_year'
  | 'owner'
  // Launch agency (who conducted the launch) — compiles to launchFilter tags,
  // distinct from 'owner' (who operates the object).
  | 'agency';

/** One consumed span of the query → one interpretation chip. */
export interface QueryMatch {
  group: FacetGroup;
  /** Canonical value: 'PRC', 'military', 'LEO', 'starlink', 'satellite', … */
  value: string;
  /** Chip display text: 'China', 'Military', 'Starlink', … */
  label: string;
  /** Exact raw text consumed, original casing ('chinese', 'Earth Observation'). */
  token: string;
  /**
   * [start, end) char span in the RAW input. Chip removal splices the span out
   * of the input text and re-parses — the input stays the single source of
   * truth, so filters can never drift from what the box says.
   */
  start: number;
  end: number;
}

export interface QueryIR {
  /** Matches in order of appearance. Single source of truth for the chips. */
  matches: QueryMatch[];
  /** Residual (unmatched, non-stopword tokens rejoined) → name search (Fuse). */
  text: string;
}

export const EMPTY_IR: QueryIR = { matches: [], text: '' };

/**
 * Partial store patch compiled from an IR — only groups the IR constrains are
 * present; omitted groups mean "leave all-on". Country/program use the same
 * union shapes as the store's CountryFilter/ProgramFilter (declared
 * structurally here to preserve the tier boundary).
 */
export interface QueryFilterPatch {
  typeFilters?: Record<CatalogType, boolean>;
  statusFilters?: Record<OrbitalStatus, boolean>;
  sectorFilters?: Record<SectorFilterKey, boolean>;
  purposeFilters?: Record<Purpose, boolean>;
  regimeFilters?: Record<OrbitalRegime, boolean>;
  countryFilter?: { mode: 'only'; codes: Set<string> };
  programFilter?: { mode: 'only'; ids: Set<string> };
  // G3: vehicle/site/launch/year facets resolve to a launch-tag allow-set;
  // owner resolves to an org-code allow-set. Same union shapes as above.
  launchFilter?: { mode: 'only'; tags: Set<string> };
  ownerFilter?: { mode: 'only'; codes: Set<string> };
}
