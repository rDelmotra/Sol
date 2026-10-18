// ============================================================
// Facet key registry — the ONE ordered list of keys per filter facet.
//
// Previously hand-copied in the old FilterPanel, the query executor,
// store/filterSlice, data/types (emptyFacetCounts) and SatelliteRenderer. Key ORDER
// is load-bearing (Object.keys iteration), pinned by facets.test.ts.
// Content (labels / colours / aliases) deliberately stays elsewhere.
// Pure data tier: type-only imports of local types, contracts for the enums.
// ============================================================

import {
  OBJECT_TYPES,
  ORBITAL_STATUSES,
  PURPOSES,
  SECTORS,
  type OrbitalStatus,
  type Purpose,
} from '@orbitwatch/contracts';
import type { CatalogType } from './types';
import type { SectorFilterKey } from './metadata-types';

export const TYPE_KEYS: readonly CatalogType[] = [...OBJECT_TYPES, 'deep_space'];
export const STATUS_KEYS: readonly OrbitalStatus[] = ORBITAL_STATUSES;
export const SECTOR_KEYS: readonly SectorFilterKey[] = [...SECTORS, 'unspecified'];
export const PURPOSE_KEYS: readonly Purpose[] = PURPOSES;

/** A fresh record with every key `true`, in key order. */
export function allOn<K extends string>(keys: readonly K[]): Record<K, boolean> {
  const rec = {} as Record<K, boolean>;
  for (const k of keys) rec[k] = true;
  return rec;
}

/** A fresh record with every key `0`, in key order. */
export function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
  const rec = {} as Record<K, number>;
  for (const k of keys) rec[k] = 0;
  return rec;
}
