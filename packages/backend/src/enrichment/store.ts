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
import type {
  ObjectMetadata,
  InlineMetadataFacets,
  DecayedCatalogRow,
  EnrichmentArtifactMeta,
} from './types.js';
import { matchProgram } from './programs.js';
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
    // { meta, objects } envelope (G1+); tolerate the legacy flat map too.
    const parsed = JSON.parse(readFileSync(METADATA_PATH, 'utf8')) as {
      meta?: EnrichmentArtifactMeta;
      objects?: Record<string, ObjectMetadata>;
    } & Record<string, ObjectMetadata>;
    const objects = parsed.objects ?? parsed;
    for (const key of Object.keys(objects)) {
      const norad = Number(key);
      if (Number.isFinite(norad)) map.set(norad, objects[key] as ObjectMetadata);
    }
    const snap = parsed.meta?.gcatSnapshot ? ` (GCAT snapshot: ${parsed.meta.gcatSnapshot})` : '';
    logger.info(`Enrichment metadata loaded: ${map.size} records${snap}`);
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
 * Pure facet derivation — exported for unit tests (no disk / module cache).
 *
 * Precedence:
 *  1. Record values (artifact) — the artifact omits null/empty, so coalesce.
 *  2. Artifact `program` wins over any live name match (keeps GLONASS tagged
 *     correctly even though its live name "COSMOS NNNN" would hit the
 *     membership-only cosmos entry).
 *  3. Only when there is still no program AND a name is given AND the caller
 *     says the object is a payload: live-match the name and fill ONLY-empty
 *     facets from the program defaults. This is the path that covers
 *     post-snapshot launches with no enrichment record at all.
 *
 * Composes a fresh object every call — never mutates the cached record.
 * `status` is the orbital status from satcat.csv (the cron does NOT override
 * it — Space-Track has none); unmatched objects stay 'unknown'.
 */
export function deriveInlineFacets(
  m: ObjectMetadata | undefined,
  name?: string,
  isPayload?: boolean,
): InlineMetadataFacets {
  const facets: InlineMetadataFacets = {
    operatorCountry: m?.operatorCountry ?? null,
    sectors: m?.sectors ?? [],
    purpose: m?.purpose ?? 'other',
    status: m?.orbitalStatus ?? 'unknown',
  };
  if (m?.program) {
    facets.program = m.program;
    return facets;
  }
  if (!name || isPayload !== true) return facets;

  const entry = matchProgram(name);
  if (!entry) return facets;

  facets.program = entry.id;
  if (facets.sectors.length === 0 && entry.sectors && entry.sectors.length > 0) {
    facets.sectors = [...entry.sectors];
  }
  if (facets.purpose === 'other' && entry.purpose) facets.purpose = entry.purpose;
  if (!facets.operatorCountry && entry.operatorCountry) {
    facets.operatorCountry = entry.operatorCountry;
  }
  return facets;
}

/**
 * The compact facets inlined onto EnrichedTLEObject. Coalesces missing fields
 * AND missing records to safe defaults, so the cron join never produces an
 * undefined facet. Pass the live object name + payload flag to enable the
 * program-registry fallback for post-snapshot launches (see deriveInlineFacets).
 */
export function getInlineFacets(
  noradId: number,
  name?: string,
  isPayload?: boolean,
): InlineMetadataFacets {
  return deriveInlineFacets(loadEnrichment().get(noradId), name, isPayload);
}

/** Load (once) the slim decayed/deorbited rows for the catalog browser. */
export function getDecayedCatalog(): DecayedCatalogRow[] {
  if (decayedCache) return decayedCache;

  let rows: DecayedCatalogRow[] = [];
  try {
    // { meta, rows } envelope (G1+); tolerate the legacy bare array too.
    const parsed = JSON.parse(readFileSync(DECAYED_PATH, 'utf8')) as
      | DecayedCatalogRow[]
      | { meta?: EnrichmentArtifactMeta; rows: DecayedCatalogRow[] };
    rows = Array.isArray(parsed) ? parsed : parsed.rows ?? [];
    logger.info(`Decayed catalog loaded: ${rows.length} rows`);
  } catch (err) {
    logger.warn(`Decayed catalog unavailable (${(err as Error).message}).`);
  }
  decayedCache = rows;
  return rows;
}
