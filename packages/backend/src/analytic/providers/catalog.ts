// ============================================================
// P3 S2 Parts A+B — Catalog provider + All-spine provider.
// Spec: my_plans/marvin/p3/S2_catalog_provider_universe_all.md
//
// Part A: catalog-plane fields from the cached live TLE catalog (readCache()),
// version-aware in-memory. The live universe's spine.
// Part B: the universe:'all' spine (catalog ∪ 69k enrichment map) + identity
// fallbacks for dead objects from getDecayedCatalog().
// ============================================================

import type { FieldValue } from '@orbitwatch/analytic';
import { readCache, readVersion } from '../../cache/file-cache.js';
import { loadEnrichment, getDecayedCatalog } from '../../enrichment/store.js';
import type { EnrichedTLEObject, VersionInfo } from '../../types/index.js';
import type { DecayedCatalogRow } from '../../enrichment/types.js';
import { logger } from '../../utils/logger.js';
import type { FieldProvider, SpineProvider } from '../types.js';
import { createVersionGuard } from './version-guard.js';

const MU_KM3_S2 = 398600.4418;
const MS_PER_YEAR = 365.25 * 86400_000;

/** Shared loader seam for both factories — same injected-deps pattern as analytic-compiler.ts. */
export interface CatalogSourceDeps {
  readCatalog?: () => EnrichedTLEObject[] | null;
  readVersion?: () => VersionInfo | null;
  enrichment?: () => Map<number, unknown>;
  decayed?: () => DecayedCatalogRow[];
}

function ommNum(o: EnrichedTLEObject, key: string): number | null {
  const v = (o.omm as unknown as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const CATALOG_FIELDS: readonly string[] = [
  'noradId', 'name', 'cospar', 'objectType', 'category', 'regime', 'status',
  'sectors', 'purpose', 'countryCode', 'program', 'owner', 'launchTag',
  'launchDate', 'rcsSize', 'epoch',
  'meanMotion', 'meanMotionDot', 'meanMotionDdot', 'bstar', 'eccentricity',
  'inclination', 'raOfAscNode', 'argOfPericenter', 'meanAnomaly',
  'period', 'apogeeKm', 'perigeeKm',
  'meanAltitudeKm', 'semiMajorAxisKm', 'ageYears', 'launchYear',
];

// ============================================================
// Part A — Catalog provider (live universe spine)
// ============================================================

export function createCatalogProvider(deps: CatalogSourceDeps = {}): FieldProvider & SpineProvider {
  const readCatalogFn = deps.readCatalog ?? readCache;
  const readVersionFn = deps.readVersion ?? readVersion;
  const guard = createVersionGuard(readVersionFn);

  let catalog: EnrichedTLEObject[] = [];
  let byNorad = new Map<number, number>();
  let spineIds: readonly number[] = [];

  function ensureFresh(): void {
    if (!guard.shouldReload()) return;
    catalog = readCatalogFn() ?? [];
    const idx = new Map<number, number>();
    catalog.forEach((o, i) => idx.set(o.noradId, i));
    byNorad = idx;
    spineIds = catalog.map((o) => o.noradId);
    logger.info(`Catalog provider (analytic): ${catalog.length} objects loaded, version=${guard.currentVersion() ?? 'unknown'}`);
  }

  function getField(noradId: number, field: string, tMs: number): FieldValue {
    ensureFresh();
    const i = byNorad.get(noradId);
    if (i === undefined) return null;
    const o = catalog[i];

    switch (field) {
      case 'noradId': return o.noradId;
      case 'name': return o.name;
      case 'category': return o.category;
      case 'regime': return o.regime;
      case 'countryCode': return o.countryCode || null;
      case 'rcsSize': return o.rcsSize;
      case 'epoch': return o.epoch;
      case 'launchDate': return o.launchDate;
      case 'objectType': return o.objectType === 'satellite' ? 'payload' : o.objectType;
      case 'period': return o.period;
      case 'apogeeKm': return o.apogee;
      case 'perigeeKm': return o.perigee;
      case 'inclination': return o.inclination;
      case 'cospar': return o.omm.OBJECT_ID ?? null;
      case 'meanMotion': return ommNum(o, 'MEAN_MOTION');
      case 'meanMotionDot': return ommNum(o, 'MEAN_MOTION_DOT');
      case 'meanMotionDdot': return ommNum(o, 'MEAN_MOTION_DDOT');
      case 'bstar': return ommNum(o, 'BSTAR');
      case 'eccentricity': return ommNum(o, 'ECCENTRICITY');
      case 'raOfAscNode': return ommNum(o, 'RA_OF_ASC_NODE');
      case 'argOfPericenter': return ommNum(o, 'ARG_OF_PERICENTER');
      case 'meanAnomaly': return ommNum(o, 'MEAN_ANOMALY');
      case 'sectors': return o.sectors;
      case 'purpose': return o.purpose;
      case 'status': return o.status;
      case 'program': return o.program ?? null;
      case 'launchTag': return o.launchTag ?? null;
      case 'owner': return o.owner ?? null;
      case 'meanAltitudeKm': return (o.apogee + o.perigee) / 2;
      case 'semiMajorAxisKm': {
        const n = ommNum(o, 'MEAN_MOTION');
        if (!n || n <= 0) return null;
        const radPerSec = (n * 2 * Math.PI) / 86400;
        return Math.cbrt(MU_KM3_S2 / (radPerSec * radPerSec));
      }
      case 'ageYears':
        return o.launchDate ? (tMs - Date.parse(o.launchDate)) / MS_PER_YEAR : null;
      case 'launchYear': {
        if (!o.launchDate) return null;
        const y = parseInt(o.launchDate.slice(0, 4), 10);
        return Number.isFinite(y) ? y : null;
      }
      default: return null;
    }
  }

  function spine(): readonly number[] {
    ensureFresh();
    return spineIds;
  }

  return {
    id: 'catalog',
    fields: CATALOG_FIELDS,
    getField,
    spine,
  };
}

// ============================================================
// Part B — All-spine provider (universe:'all' spine + dead-object identity)
// ============================================================

const ALL_SPINE_FIELDS: readonly string[] = ['noradId', 'name', 'countryCode', 'launchYear'];

export function createAllSpineProvider(deps: CatalogSourceDeps = {}): FieldProvider & SpineProvider {
  const readCatalogFn = deps.readCatalog ?? readCache;
  const readVersionFn = deps.readVersion ?? readVersion;
  const enrichmentFn = deps.enrichment ?? loadEnrichment;
  const decayedFn = deps.decayed ?? getDecayedCatalog;
  const guard = createVersionGuard(readVersionFn);

  let spineIds: readonly number[] = [];
  let decayedByNorad = new Map<number, DecayedCatalogRow>();

  function ensureFresh(): void {
    if (!guard.shouldReload()) return;
    const catalog = readCatalogFn() ?? [];
    const enrichmentKeys = enrichmentFn();

    const idSet = new Set<number>();
    for (const o of catalog) idSet.add(o.noradId);
    for (const id of enrichmentKeys.keys()) idSet.add(id);
    spineIds = Array.from(idSet).sort((a, b) => a - b);

    const byNorad = new Map<number, DecayedCatalogRow>();
    for (const row of decayedFn()) byNorad.set(row.noradId, row);
    decayedByNorad = byNorad;

    logger.info(
      `All-spine provider (analytic): ${spineIds.length} objects ` +
        `(catalog ${catalog.length} ∪ enrichment ${enrichmentKeys.size})`,
    );
  }

  function getField(noradId: number, field: string, _tMs: number): FieldValue {
    ensureFresh();
    switch (field) {
      case 'noradId': return noradId; // spine identity — never null
      case 'name': return decayedByNorad.get(noradId)?.name ?? null;
      case 'countryCode': return decayedByNorad.get(noradId)?.country ?? null;
      case 'launchYear': return decayedByNorad.get(noradId)?.launchYear ?? null;
      default: return null;
    }
  }

  function spine(): readonly number[] {
    ensureFresh();
    return spineIds;
  }

  return {
    id: 'all-spine',
    fields: ALL_SPINE_FIELDS,
    getField,
    spine,
  };
}
