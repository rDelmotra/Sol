// ============================================================
// Analytic IR v1 — field registry (schema-as-code).
//
// The single source the validator type-checks against, and the source the
// future LLM-compiler prompt is GENERATED from (one source, no drift —
// perceptor_analytic_schema.md §9.7). Field semantics, units and coverage
// live in the schema doc; this file is its machine form.
//
// Planes: 'live' fields exist only while the object has a current TLE and a
// worker tick (universe 'live' REQUIRED — validator V-PLANE). 'catalog'
// fields come from the current elset (null for decayed objects under
// universe 'all' — skip-and-count, reported via meta.coverage). 'static'
// fields come from the enrichment snapshot and exist on both universes.
//
// Coverage numbers: measured 2026-07 over the 69,242-record enrichment
// artifact (GCAT snapshot 2026-07-03). Omitted coverage = effectively full.
//
// NOTE `objectType` is the GCAT 5-way domain (incl. 'payload'/'component');
// the live catalog's 4-way ObjectType ('satellite'…) is translated by the
// tier-0 QueryFilterPatch embedding ('satellite' → 'payload'); DSOs are out
// of scope for the analytic universe in v1.
// ============================================================

export type FieldKind = 'number' | 'string' | 'bool' | 'date' | 'enum' | 'enumSet' | 'id';
export type FieldPlane = 'live' | 'catalog' | 'static';
// NOTE on plane for the space-weather fields below (solarFlux10cm/
// geomagneticAp/geomagneticKp): none of the three planes actually describe
// them. They're GLOBAL (same value for every object at a given instant,
// unlike every other field here) and TIME-VARYING (unlike 'static', which
// means "doesn't change"; unlike 'catalog', which means "per-object current
// elset"; unlike 'live', which means "requires a live worker tick per
// object"). They were filed under 'static' as the least-wrong fit — "doesn't
// depend on which object you ask about" is the property 'static' shares with
// them, even though the "doesn't change over time" half of that name is
// false for them. A real 'global' plane (time-varying, object-independent,
// safe on both universes, no per-object boot-measurement loop needed) is the
// honest fix if a second global-value domain ever lands. See
// providers/space-weather.ts and the P3 space-weather task report.

export interface FieldSpec {
  kind: FieldKind;
  plane: FieldPlane;
  unit?: string;
  domain?: readonly string[];
  /** Fraction of the 69,242-record enrichment universe with a value, as of the
   *  snapshot noted above. Docs value only (P3 S6) — the backend compiler prompt
   *  renders MEASURED coverage from DataSourceRegistry.snapshot() at boot, never
   *  this static number, so the prompt can't drift from what the real adapter serves. */
  coverage?: number;
  /** Computed on demand (derived registry / dotted join path), not stored. */
  derived?: true;
}

// ── Enum domains ──────────────────────────────────────────────────────────────

export const OBJECT_TYPE_DOMAIN = ['payload', 'rocket_body', 'debris', 'component', 'unknown'] as const;
export const CATEGORY_DOMAIN = ['active_satellite', 'inactive_satellite', 'rocket_body', 'debris', 'unknown', 'deep_space'] as const;
export const REGIME_DOMAIN = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'] as const;
export const ORBITAL_STATUS_DOMAIN = ['in_orbit', 'decayed', 'deorbited', 'beyond_earth', 'exploded', 'unknown'] as const;
export const OPERATIONAL_STATUS_DOMAIN = ['operational', 'partial', 'nonoperational', 'backup', 'spare', 'extended', 'unknown'] as const;
export const SECTOR_DOMAIN = ['commercial', 'government', 'military', 'civil'] as const;
export const PURPOSE_DOMAIN = ['communications', 'earth_observation', 'navigation', 'technology_dev', 'space_science', 'space_observation', 'surveillance', 'meteorological', 'other'] as const;

// ── The registry ──────────────────────────────────────────────────────────────

export const FIELD_REGISTRY: Record<string, FieldSpec> = {
  // Identity & classification
  noradId: { kind: 'id', plane: 'catalog' },
  name: { kind: 'string', plane: 'catalog' },
  cospar: { kind: 'string', plane: 'static' },
  jcat: { kind: 'string', plane: 'static', coverage: 0.998 },
  objectType: { kind: 'enum', plane: 'static', domain: OBJECT_TYPE_DOMAIN, coverage: 0.998 },
  category: { kind: 'enum', plane: 'catalog', domain: CATEGORY_DOMAIN },
  regime: { kind: 'enum', plane: 'catalog', domain: REGIME_DOMAIN },
  status: { kind: 'enum', plane: 'static', domain: ORBITAL_STATUS_DOMAIN, coverage: 0.998 },
  operationalStatus: { kind: 'enum', plane: 'static', domain: OPERATIONAL_STATUS_DOMAIN, coverage: 0.392 },
  sectors: { kind: 'enumSet', plane: 'static', domain: SECTOR_DOMAIN },
  purpose: { kind: 'enum', plane: 'static', domain: PURPOSE_DOMAIN, coverage: 0.939 },
  countryCode: { kind: 'string', plane: 'catalog' },
  program: { kind: 'string', plane: 'static', coverage: 0.773 },
  owner: { kind: 'string', plane: 'static' },
  launchTag: { kind: 'string', plane: 'static', coverage: 0.998 },
  parentJcat: { kind: 'string', plane: 'static', coverage: 0.998 },
  launchDate: { kind: 'date', plane: 'catalog', coverage: 0.998 },
  rcsSize: { kind: 'string', plane: 'catalog' },

  // Mean elements (current elset)
  epoch: { kind: 'date', plane: 'catalog' },
  meanMotion: { kind: 'number', plane: 'catalog', unit: 'rev/day' },
  meanMotionDot: { kind: 'number', plane: 'catalog', unit: 'rev/day^2' },
  meanMotionDdot: { kind: 'number', plane: 'catalog', unit: 'rev/day^3' },
  bstar: { kind: 'number', plane: 'catalog', unit: '1/ER' },
  eccentricity: { kind: 'number', plane: 'catalog' },
  inclination: { kind: 'number', plane: 'catalog', unit: 'deg' },
  raOfAscNode: { kind: 'number', plane: 'catalog', unit: 'deg' },
  argOfPericenter: { kind: 'number', plane: 'catalog', unit: 'deg' },
  meanAnomaly: { kind: 'number', plane: 'catalog', unit: 'deg' },
  period: { kind: 'number', plane: 'catalog', unit: 'min' },
  apogeeKm: { kind: 'number', plane: 'catalog', unit: 'km' },
  perigeeKm: { kind: 'number', plane: 'catalog', unit: 'km' },

  // Physical / spec (static, partial — coverage measured)
  launchMassKg: { kind: 'number', plane: 'static', unit: 'kg', coverage: 0.538 },
  dryMassKg: { kind: 'number', plane: 'static', unit: 'kg', coverage: 0.537 },
  totMassKg: { kind: 'number', plane: 'static', unit: 'kg', coverage: 0.504 },
  lengthM: { kind: 'number', plane: 'static', unit: 'm', coverage: 0.534 },
  diameterM: { kind: 'number', plane: 'static', unit: 'm', coverage: 0.535 },
  spanM: { kind: 'number', plane: 'static', unit: 'm', coverage: 0.537 },
  powerW: { kind: 'number', plane: 'static', unit: 'W', coverage: 0.008 },
  expectedLifetimeYrs: { kind: 'number', plane: 'static', unit: 'yr', coverage: 0.079 },
  bus: { kind: 'string', plane: 'static', coverage: 0.54 },
  shape: { kind: 'string', plane: 'static', coverage: 0.537 },

  // Derived registry (computed at the program's bound time where live)
  speedKmS: { kind: 'number', plane: 'live', unit: 'km/s', derived: true },
  altitudeKm: { kind: 'number', plane: 'live', unit: 'km', derived: true },
  latDeg: { kind: 'number', plane: 'live', unit: 'deg', derived: true },
  lonDeg: { kind: 'number', plane: 'live', unit: 'deg', derived: true },
  eclipsed: { kind: 'bool', plane: 'live', derived: true },
  meanAltitudeKm: { kind: 'number', plane: 'catalog', unit: 'km', derived: true },
  semiMajorAxisKm: { kind: 'number', plane: 'catalog', unit: 'km', derived: true },
  ageYears: { kind: 'number', plane: 'catalog', unit: 'yr', derived: true, coverage: 0.998 },
  launchYear: { kind: 'number', plane: 'catalog', derived: true, coverage: 0.998 },
  ownerFamily: { kind: 'string', plane: 'static', derived: true },

  // Dotted join paths (1 hop, read-only; missing join row → null)
  'launch.date': { kind: 'date', plane: 'static', derived: true, coverage: 0.998 },
  'launch.lvType': { kind: 'string', plane: 'static', derived: true, coverage: 0.998 },
  'launch.lvFamily': { kind: 'string', plane: 'static', derived: true, coverage: 0.998 },
  'launch.siteName': { kind: 'string', plane: 'static', derived: true, coverage: 0.998 },
  'launch.pad': { kind: 'string', plane: 'static', derived: true },
  'launch.success': { kind: 'bool', plane: 'static', derived: true, coverage: 0.998 },
  'owner.name': { kind: 'string', plane: 'static', derived: true },
  'owner.stateCode': { kind: 'string', plane: 'static', derived: true },
  'owner.cls': { kind: 'string', plane: 'static', derived: true },
  'program.label': { kind: 'string', plane: 'static', derived: true, coverage: 0.773 },

  // Space weather (NOAA SWPC daily indices) — global, time-varying, same
  // value for every object at a given instant; see the FieldPlane note above
  // for why these are filed under 'static'. Coverage: the source text
  // products carry a trailing 30-day window, so these resolve to null for
  // any bound time older than ~30 days — no fixed number captures that
  // (it's a moving window, not a fraction of a fixed corpus), so coverage is
  // left unset here (docs-only field; the real runtime number comes from
  // DataSourceRegistry.snapshot() same as everything else).
  solarFlux10cm: { kind: 'number', plane: 'static', unit: 'sfu' },
  geomagneticAp: { kind: 'number', plane: 'static' },
  geomagneticKp: { kind: 'number', plane: 'static' },
};

// ── Function specs (spec §5) ──────────────────────────────────────────────────
// All evaluate at the program's bound time. Only descendsFrom is static-plane
// (separation-tree walk) — the rest need live worker state.

export interface FnSpec {
  plane: FieldPlane;
  returns: 'number' | 'bool';
}

export const FN_SPECS: Record<string, FnSpec> = {
  elevationDeg: { plane: 'live', returns: 'number' },
  rangeKm: { plane: 'live', returns: 'number' },
  observerDark: { plane: 'live', returns: 'bool' },
  visuallyVisible: { plane: 'live', returns: 'bool' },
  distToKm: { plane: 'live', returns: 'number' },
  descendsFrom: { plane: 'static', returns: 'bool' },
};

/** Sortable kinds — sort.by must resolve to one of these. */
export const SORTABLE_KINDS: readonly FieldKind[] = ['number', 'date', 'string', 'id', 'enum'];
