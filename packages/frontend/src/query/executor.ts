// ============================================================
// Query executor — QueryIR → QueryFilterPatch (partial store state).
//
// For each facet group the IR constrains: a FRESH record with every key false
// and the matched values true. Groups with no matches are omitted (they stay
// all-on downstream). Sector semantics: a 'military' match narrows the group
// to {military: true, rest false} — the renderer's any-of loop still admits a
// multi-sector object tagged [military, government].
// ============================================================

import { emptyFacetCounts, type CatalogType, type OrbitalRegime } from '../data/types';
import type { Purpose, SectorFilterKey, OrbitalStatus } from '../data/metadata-types';
import { getVocabIndexes } from './vocab';
import type { QueryIR, QueryFilterPatch, FacetGroup } from './types';

// Key universes derived from the one canonical source (emptyFacetCounts) so
// enum growth can't drift. Regimes aren't in FacetCounts — hardcoded.
const EMPTY = emptyFacetCounts();
export const TYPE_KEYS = Object.keys(EMPTY.type) as CatalogType[];
export const STATUS_KEYS = Object.keys(EMPTY.status) as OrbitalStatus[];
export const SECTOR_KEYS = Object.keys(EMPTY.sector) as SectorFilterKey[];
export const PURPOSE_KEYS = Object.keys(EMPTY.purpose) as Purpose[];
export const REGIME_KEYS: OrbitalRegime[] = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];

function narrow<K extends string>(keys: readonly K[], on: Set<string>): Record<K, boolean> {
  const rec = {} as Record<K, boolean>;
  for (const k of keys) rec[k] = on.has(k);
  return rec;
}

export function irToFilterPatch(ir: QueryIR): QueryFilterPatch {
  const byGroup = new Map<FacetGroup, Set<string>>();
  for (const m of ir.matches) {
    const set = byGroup.get(m.group) ?? new Set<string>();
    set.add(m.value);
    byGroup.set(m.group, set);
  }

  const patch: QueryFilterPatch = {};
  const types = byGroup.get('type');
  if (types) patch.typeFilters = narrow(TYPE_KEYS, types);
  const statuses = byGroup.get('status');
  if (statuses) patch.statusFilters = narrow(STATUS_KEYS, statuses);
  const sectors = byGroup.get('sector');
  if (sectors) patch.sectorFilters = narrow(SECTOR_KEYS, sectors);
  const purposes = byGroup.get('purpose');
  if (purposes) patch.purposeFilters = narrow(PURPOSE_KEYS, purposes);
  const regimes = byGroup.get('regime');
  if (regimes) patch.regimeFilters = narrow(REGIME_KEYS, regimes);
  const countries = byGroup.get('country');
  if (countries) patch.countryFilter = { mode: 'only', codes: new Set(countries) };
  const programs = byGroup.get('program');
  if (programs) patch.programFilter = { mode: 'only', ids: new Set(programs) };

  // ── G3: operator (union) + launch-graph (intersection across subgroups) ──────
  const owners = byGroup.get('owner');
  if (owners) patch.ownerFilter = { mode: 'only', codes: new Set(owners) };

  const vehicles = byGroup.get('vehicle');
  const sites = byGroup.get('site');
  const launches = byGroup.get('launch');
  const years = byGroup.get('launch_year');
  if (vehicles || sites || launches || years) {
    const idx = getVocabIndexes();
    const unionTags = (index: Map<string, Set<string>> | undefined, values: Set<string>) => {
      const out = new Set<string>();
      for (const v of values) for (const t of index?.get(v) ?? []) out.add(t);
      return out;
    };
    // Each subgroup contributes ONE tag set (union of its values); the final
    // allow-set is the INTERSECTION across subgroups. "falcon 9 from vandenberg
    // 2021" = tags(Falcon9) ∩ tags(Vandenberg) ∩ tags(2021).
    const subsets: Set<string>[] = [];
    if (launches) subsets.push(new Set(launches)); // tags match directly (vocab-free)
    if (vehicles) subsets.push(unionTags(idx?.vehicleTags, vehicles));
    if (sites) subsets.push(unionTags(idx?.siteTags, sites));
    if (years) subsets.push(unionTags(idx?.yearTags, years));
    let tags = subsets[0];
    for (let s = 1; s < subsets.length; s++) {
      tags = new Set([...tags].filter((t) => subsets[s].has(t)));
    }
    patch.launchFilter = { mode: 'only', tags };
  }
  return patch;
}
