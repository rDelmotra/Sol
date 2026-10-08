/**
 * Frontend DSO types.
 *
 * The wire/domain shapes (DsoId, DsoProvider, DsoTargetBody, DsoRegime,
 * DsoFreshnessState, DsoSourceFrame, CanonicalStateVector, DsoSnapshot,
 * DsoCatalogEntry, DsoCatalog, DsoObjectStatus, DsoManifest) moved to
 * @orbitwatch/contracts in C2b — import them from there. DsoObject stays
 * here: it's frontend-local (the product of merging a DsoCatalogEntry with
 * its loaded ephemeris state), never served on the wire.
 */

import type { DsoFreshnessState, DsoRegime } from '@orbitwatch/contracts';

/**
 * Frontend-local DSO object — the product of merging a DsoCatalogEntry
 * with its loaded ephemeris state.
 */
export interface DsoObject {
  source: 'dso';
  dsoId: string;
  slug: string;
  name: string;
  mission: string;
  targetBody: string;
  regime: DsoRegime;
  provider: string;
  freshnessState: DsoFreshnessState;
  searchAliases: string[];
}

export interface DsoLabelPosition {
  dsoId: string;
  name: string;
  screenX: number;
  screenY: number;
  visible: boolean;
}
