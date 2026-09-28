// ============================================================
// @orbitwatch/contracts — enums.ts
//
// ZERO imports. `as const` arrays + derived union types for the domains that
// are hand-mirrored, verbatim, across packages today. This is step C1 of
// PROJECT_MAP/15_ORBITAL_CORE_AND_CONTRACTS.md — ONLY packages/analytic/src/
// schema.ts is switched to consume these arrays in this step (C1). Backend
// and frontend consumers (types/index.ts, enrichment/types.ts, data/types.ts,
// metadata-types.ts) keep their own copies until C2a/C2b; each array below
// documents its origin so that migration can diff literal-for-literal.
//
// Element order matters: it is pinned by enums.test.ts, and the analytic
// domains must keep EXACTLY the order of packages/analytic/src/schema.ts
// (56-62) today, since `schema.ts` now derives its `*_DOMAIN` exports from
// these arrays and callers assume stable array indices are not part of the
// contract, but literal membership/order is (golden-corpus + prompt fingerprint
// stability).
// ============================================================

// ── Analytic IR domains ──────────────────────────────────────────────────────
// Source of truth for order: packages/analytic/src/schema.ts:56-62
// (OBJECT_TYPE_DOMAIN..PURPOSE_DOMAIN, read 2026-09-28). This is the Analytic
// IR v1 spelling — objectType here says 'payload' (GCAT-flavoured), NOT the
// live-catalog wire spelling; see OBJECT_TYPES / ObjectType below for that one.
//
// NAMING (deliberate): `ObjectType`/`OBJECT_TYPES` = the WIRE spelling, matching
// the name backend types/index.ts + frontend data/types.ts already use for
// EnrichedTLEObject.objectType. The IR spelling is `AnalyticObjectType`.
// (backend enrichment/types.ts calls the IR spelling `CatalogObjectType` —
// C2a migrates that to AnalyticObjectType.)

/**
 * Analytic IR `objectType` domain (schema.ts OBJECT_TYPE_DOMAIN).
 * Also mirrored, independently, as backend `enrichment/types.ts`'s
 * `CatalogObjectType` (payload/rocket_body/debris/component/unknown) — same
 * members, same order, despite that mirror's name colliding with the
 * unrelated wire-spelled type below.
 */
export const ANALYTIC_OBJECT_TYPES = ['payload', 'rocket_body', 'debris', 'component', 'unknown'] as const;
export type AnalyticObjectType = (typeof ANALYTIC_OBJECT_TYPES)[number];

/**
 * `category` domain (schema.ts CATEGORY_DOMAIN). Mirrored verbatim as backend
 * `types/index.ts`'s `ObjectCategory` and frontend `data/types.ts`'s
 * `ObjectCategory`.
 */
export const OBJECT_CATEGORIES = [
  'active_satellite',
  'inactive_satellite',
  'rocket_body',
  'debris',
  'unknown',
  'deep_space',
] as const;
export type ObjectCategory = (typeof OBJECT_CATEGORIES)[number];

/**
 * `regime` domain (schema.ts REGIME_DOMAIN). Mirrored verbatim as backend
 * `types/index.ts`'s `OrbitalRegime` and frontend `data/types.ts`'s
 * `OrbitalRegime`.
 */
export const ORBITAL_REGIMES = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'] as const;
export type OrbitalRegime = (typeof ORBITAL_REGIMES)[number];

/**
 * `status` (orbital status) domain (schema.ts ORBITAL_STATUS_DOMAIN). Mirrored
 * verbatim as backend `enrichment/types.ts`'s `OrbitalStatus` and frontend
 * `metadata-types.ts`'s `OrbitalStatus`.
 */
export const ORBITAL_STATUSES = [
  'in_orbit',
  'decayed',
  'deorbited',
  'beyond_earth',
  'exploded',
  'unknown',
] as const;
export type OrbitalStatus = (typeof ORBITAL_STATUSES)[number];

/**
 * `operationalStatus` domain (schema.ts OPERATIONAL_STATUS_DOMAIN). Mirrored
 * verbatim as backend `enrichment/types.ts`'s `OperationalStatus` and
 * frontend `metadata-types.ts`'s `OperationalStatus`.
 */
export const OPERATIONAL_STATUSES = [
  'operational',
  'partial',
  'nonoperational',
  'backup',
  'spare',
  'extended',
  'unknown',
] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

/**
 * `sectors` domain (schema.ts SECTOR_DOMAIN). Mirrored verbatim as backend
 * `enrichment/types.ts`'s `Sector` and frontend `metadata-types.ts`'s
 * `Sector`. (Frontend also has `SectorFilterKey = Sector | 'unspecified'`,
 * a UI-local filter-key extension — stays package-local, not part of this
 * domain.)
 */
export const SECTORS = ['commercial', 'government', 'military', 'civil'] as const;
export type Sector = (typeof SECTORS)[number];

/**
 * `purpose` domain (schema.ts PURPOSE_DOMAIN). Mirrored verbatim as backend
 * `enrichment/types.ts`'s `Purpose` and frontend `metadata-types.ts`'s
 * `Purpose`.
 */
export const PURPOSES = [
  'communications',
  'earth_observation',
  'navigation',
  'technology_dev',
  'space_science',
  'space_observation',
  'surveillance',
  'meteorological',
  'other',
] as const;
export type Purpose = (typeof PURPOSES)[number];

// ── Wire/catalog domains (spelling differs from the analytic IR) ──────────────

/**
 * Live-catalog `objectType` — the classified Space-Track/CelesTrak OBJECT_TYPE
 * served on `EnrichedTLEObject` and consumed by the SGP4 worker. Mirrored
 * verbatim as backend `types/index.ts`'s `ObjectType` and frontend
 * `data/types.ts`'s `ObjectType`.
 *
 * NOT the same domain as ANALYTIC_OBJECT_TYPES above: this one says 'satellite' where
 * the analytic IR says 'payload', and has no 'component' member (the live
 * worker never sees GCAT's finer-grained component classification — that
 * only exists in the enrichment/static plane). The tier-0 QueryFilterPatch
 * translates 'satellite' -> 'payload' at the analytic boundary (see
 * schema.ts's header comment).
 */
export const OBJECT_TYPES = ['satellite', 'rocket_body', 'debris', 'unknown'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

// ── Metadata provenance ────────────────────────────────────────────────────────

/**
 * Which snapshot/join contributed a given `ObjectMetadata` facet. Mirrored
 * verbatim as backend `enrichment/types.ts`'s `MetadataSource` and frontend
 * `metadata-types.ts`'s `MetadataSource`. Not part of the analytic IR domain
 * set (no analytic field exposes provenance directly).
 */
export const METADATA_SOURCES = [
  'ucs-2023-05',
  'gcat',
  'gcat-org',
  'spacetrack',
  'inferred',
  'inherited',
] as const;
export type MetadataSource = (typeof METADATA_SOURCES)[number];
