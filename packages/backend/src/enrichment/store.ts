// ============================================================
// Enrichment store — boot-loaded, in-memory metadata lookup.
//
// Loads the committed build-time artifacts (enrichment-data/*.json) once into
// memory. Lazy + idempotent: the first access reads from disk; subsequent calls
// hit the cache. Missing files degrade gracefully (empty Map / [] + a warning),
// mirroring the DSO module's "TLE backend untouched if metadata is absent" stance.
//
// Anchored at the backend package root via ../../enrichment-data, so the path
// resolves identically under tsx (dev, __dirname=src/enrichment) and node
// (prod, __dirname=dist/enrichment) — the same trick file-cache.ts uses for data/.
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ObjectMetadata, InlineMetadataFacets, DecayedCatalogRow } from './types.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../../enrichment-data');
const METADATA_PATH = resolve(DATA_DIR, 'metadata-enrichment.json');
const DECAYED_PATH = resolve(DATA_DIR, 'decayed-catalog.json');

let metadataCache: Map<number, ObjectMetadata> | null = null;
let decayedCache: DecayedCatalogRow[] | null = null;

/** Load (once) the NORAD→ObjectMetadata map. Empty Map if the artifact is missing. */
export function loadEnrichment(): Map<number, ObjectMetadata> {
  if (metadataCache) return metadataCache;

  const map = new Map<number, ObjectMetadata>();
  try {
    const parsed = JSON.parse(readFileSync(METADATA_PATH, 'utf8')) as Record<string, ObjectMetadata>;
    for (const key of Object.keys(parsed)) {
      map.set(Number(key), parsed[key]);
    }
    logger.info(`Enrichment metadata loaded: ${map.size} records`);
  } catch (err) {
    logger.warn(
      `Enrichment metadata unavailable (${(err as Error).message}); serving without it. ` +
        'Run: npx tsx src/enrichment/build-enrichment.ts',
    );
  }
  metadataCache = map;
  return map;
}

/** Full metadata record for the lazy /api/metadata/:noradId route. */
export function getMetadata(noradId: number): ObjectMetadata | undefined {
  return loadEnrichment().get(noradId);
}

/**
 * The compact facets inlined onto EnrichedTLEObject. Coalesces missing fields
 * (the artifact omits null/empty values) AND missing records to safe defaults,
 * so the cron join never produces an undefined facet. `status` is the orbital
 * status from satcat.csv (the cron does NOT override it — Space-Track has none).
 */
export function getInlineFacets(noradId: number): InlineMetadataFacets {
  const m = loadEnrichment().get(noradId);
  return {
    operatorCountry: m?.operatorCountry ?? null,
    sectors: m?.sectors ?? [],
    purpose: m?.purpose ?? 'other',
    status: m?.orbitalStatus ?? 'unknown',
  };
}

/** Load (once) the slim decayed/deorbited rows for the catalog browser. */
export function getDecayedCatalog(): DecayedCatalogRow[] {
  if (decayedCache) return decayedCache;

  let rows: DecayedCatalogRow[] = [];
  try {
    rows = JSON.parse(readFileSync(DECAYED_PATH, 'utf8')) as DecayedCatalogRow[];
    logger.info(`Decayed catalog loaded: ${rows.length} rows`);
  } catch (err) {
    logger.warn(`Decayed catalog unavailable (${(err as Error).message}).`);
  }
  decayedCache = rows;
  return rows;
}
