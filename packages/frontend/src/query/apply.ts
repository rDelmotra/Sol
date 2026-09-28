// ============================================================
// reconcileFilterSlices — the reference-identity chokepoint.
//
// The SatellitesLayer store subscription diffs filter slices BY REFERENCE,
// both ways: a changed group must be a NEW object (or the sub won't fire) and
// an unchanged group must KEEP its reference (or every keystroke triggers a
// full-catalog renderer recompute). This helper makes that contract explicit
// and pure: it compares the DESIRED slice (patch group, or the all-on
// default) against the CURRENT slice by SEMANTIC equality and returns a
// partial containing ONLY the groups that really changed — each as a fresh
// object. An empty return means "don't set() at all".
//
// Semantic equality means: typing "starlink d" → "starlink dt" (residual-only
// change), or re-emitting {PRC} on every debounce tick while typing the next
// word, produces {} here → zero recomputes. Covered by apply.test.ts.
// ============================================================

import type { CatalogType } from '../data/types';
import type { OrbitalRegime, Purpose, OrbitalStatus } from '@orbitwatch/contracts';
import type { SectorFilterKey } from '../data/metadata-types';
import {
  TYPE_KEYS,
  STATUS_KEYS,
  SECTOR_KEYS,
  PURPOSE_KEYS,
  REGIME_KEYS,
} from './executor';
import type { QueryFilterPatch } from './types';

type SetFilter<F extends string> =
  | { mode: 'all' }
  | ({ mode: 'only' } & Record<F, Set<string>>);

/** The nine query-controlled slices, shaped like the store's SatelliteFilterState. */
export interface QuerySlices {
  typeFilters: Record<CatalogType, boolean>;
  statusFilters: Record<OrbitalStatus, boolean>;
  sectorFilters: Record<SectorFilterKey, boolean>;
  purposeFilters: Record<Purpose, boolean>;
  regimeFilters: Record<OrbitalRegime, boolean>;
  countryFilter: SetFilter<'codes'>;
  programFilter: SetFilter<'ids'>;
  launchFilter: SetFilter<'tags'>;   // G3
  ownerFilter: SetFilter<'codes'>;   // G3
}

function allOn<K extends string>(keys: readonly K[]): Record<K, boolean> {
  const rec = {} as Record<K, boolean>;
  for (const k of keys) rec[k] = true;
  return rec;
}

/** Value equality over a fixed key universe (≤9 keys — cheap). */
function recordEquals<K extends string>(
  keys: readonly K[],
  a: Record<K, boolean>,
  b: Record<K, boolean>,
): boolean {
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function setFilterEquals(
  aMode: 'all' | 'only',
  aSet: Set<string> | null,
  bMode: 'all' | 'only',
  bSet: Set<string> | null,
): boolean {
  if (aMode !== bMode) return false;
  if (aMode === 'all') return true;
  if (!aSet || !bSet || aSet.size !== bSet.size) return false;
  for (const v of aSet) if (!bSet.has(v)) return false;
  return true;
}

/**
 * Compute the minimal store delta for applying a query patch with OVERWRITE
 * semantics: every query-controlled group becomes `patch.group ?? all-on`.
 * Groups whose desired state semantically equals the current state are
 * OMITTED (current reference survives); changed groups are fresh objects.
 */
export function reconcileFilterSlices(
  current: QuerySlices,
  patch: QueryFilterPatch,
): Partial<QuerySlices> {
  const delta: Partial<QuerySlices> = {};

  const boolGroup = <K extends string>(
    field: 'typeFilters' | 'statusFilters' | 'sectorFilters' | 'purposeFilters' | 'regimeFilters',
    keys: readonly K[],
  ) => {
    const desired = (patch[field] as Record<K, boolean> | undefined) ?? allOn(keys);
    if (!recordEquals(keys, desired, current[field] as Record<K, boolean>)) {
      (delta as Record<string, unknown>)[field] = { ...desired };
    }
  };
  boolGroup('typeFilters', TYPE_KEYS);
  boolGroup('statusFilters', STATUS_KEYS);
  boolGroup('sectorFilters', SECTOR_KEYS);
  boolGroup('purposeFilters', PURPOSE_KEYS);
  boolGroup('regimeFilters', REGIME_KEYS);

  const curCountry = current.countryFilter;
  const desCountryCodes = patch.countryFilter?.codes ?? null;
  if (
    !setFilterEquals(
      desCountryCodes ? 'only' : 'all',
      desCountryCodes,
      curCountry.mode,
      curCountry.mode === 'only' ? curCountry.codes : null,
    )
  ) {
    delta.countryFilter = desCountryCodes
      ? { mode: 'only', codes: new Set(desCountryCodes) }
      : { mode: 'all' };
  }

  const curProgram = current.programFilter;
  const desProgramIds = patch.programFilter?.ids ?? null;
  if (
    !setFilterEquals(
      desProgramIds ? 'only' : 'all',
      desProgramIds,
      curProgram.mode,
      curProgram.mode === 'only' ? curProgram.ids : null,
    )
  ) {
    delta.programFilter = desProgramIds
      ? { mode: 'only', ids: new Set(desProgramIds) }
      : { mode: 'all' };
  }

  const curLaunch = current.launchFilter;
  const desLaunchTags = patch.launchFilter?.tags ?? null;
  if (
    !setFilterEquals(
      desLaunchTags ? 'only' : 'all',
      desLaunchTags,
      curLaunch.mode,
      curLaunch.mode === 'only' ? curLaunch.tags : null,
    )
  ) {
    delta.launchFilter = desLaunchTags
      ? { mode: 'only', tags: new Set(desLaunchTags) }
      : { mode: 'all' };
  }

  const curOwner = current.ownerFilter;
  const desOwnerCodes = patch.ownerFilter?.codes ?? null;
  if (
    !setFilterEquals(
      desOwnerCodes ? 'only' : 'all',
      desOwnerCodes,
      curOwner.mode,
      curOwner.mode === 'only' ? curOwner.codes : null,
    )
  ) {
    delta.ownerFilter = desOwnerCodes
      ? { mode: 'only', codes: new Set(desOwnerCodes) }
      : { mode: 'all' };
  }

  return delta;
}
