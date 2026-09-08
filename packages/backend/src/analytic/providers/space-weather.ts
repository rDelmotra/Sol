// ============================================================
// Space-weather provider — daily geomagnetic (Kp/Ap) + solar radio flux
// (F10.7) indices from NOAA SWPC. The system's first CAUSAL data dimension:
// solar/geomagnetic activity drives atmospheric density, which drives drag
// and decay — this lets a question move from "what is decaying" toward "why".
//
// GLOBAL, not per-object: unlike every other provider in this directory,
// getField() ignores noradId entirely and returns the value for the UTC
// calendar day containing tMs — every satellite shares the same Kp/Ap/F10.7
// at the same instant. This is deliberate: the FieldProvider contract
// (getField(noradId, field, tMs)) accepts a noradId whether or not the
// underlying data actually varies by object, and a global-value domain fits
// it cleanly without any change to the contract itself — see the task
// report for why that's a real (if narrow) validation of the port shape.
//
// No I/O per getField() call: an in-memory Map<dateKey, SwpcDailyIndex> is
// rebuilt from the on-disk cache only when the cache's version changes
// (throttled via the shared createVersionGuard, same as catalog.ts/sgp4.ts).
// The network fetch that keeps the on-disk cache warm runs in the
// background, fire-and-forget, off the read path entirely — a query never
// blocks on NOAA.
// ============================================================

import type { FieldValue } from '@orbitwatch/analytic';
import { logger } from '../../utils/logger.js';
import { fetchSwpcDailyIndices, type SwpcDailyIndex } from '../../services/swpc.js';
import { readSwpcCache, writeSwpcCache, isSwpcCacheFresh, type SwpcCache } from '../../cache/swpc-cache.js';
import type { FieldProvider } from '../types.js';
import { createVersionGuard } from './version-guard.js';

const SPACE_WEATHER_FIELDS: readonly string[] = ['solarFlux10cm', 'geomagneticAp', 'geomagneticKp'];

// Freshness (fs.statSync) is cheap but still real I/O — throttle it to the
// same cadence as the version guard's own check, rather than stat-ing the
// cache file on every single getField() call during a full-spine boot scan.
const FRESHNESS_CHECK_INTERVAL_MS = 1000;

export interface SpaceWeatherProviderDeps {
  readCache?: () => SwpcCache | null;
  writeCache?: (records: SwpcDailyIndex[]) => SwpcCache;
  isCacheFresh?: () => boolean;
  fetchIndices?: () => Promise<SwpcDailyIndex[]>;
}

function dateKeyOf(tMs: number): string {
  return new Date(tMs).toISOString().slice(0, 10);
}

export function createSpaceWeatherProvider(deps: SpaceWeatherProviderDeps = {}): FieldProvider {
  const readCacheFn = deps.readCache ?? readSwpcCache;
  const writeCacheFn = deps.writeCache ?? writeSwpcCache;
  const isCacheFreshFn = deps.isCacheFresh ?? isSwpcCacheFresh;
  const fetchIndicesFn = deps.fetchIndices ?? fetchSwpcDailyIndices;

  // The cache file doubles as its own "version" signal (its `version` field
  // is the fetch timestamp) — no separate lightweight version file exists
  // for a payload this small (a few dozen daily records).
  const guard = createVersionGuard(readCacheFn);

  let byDate = new Map<string, SwpcDailyIndex>();
  let refreshInFlight: Promise<void> | null = null;
  let lastFreshnessCheckMs = -Infinity;

  function triggerBackgroundRefresh(): void {
    if (refreshInFlight) return;
    refreshInFlight = (async () => {
      try {
        const records = await fetchIndicesFn();
        writeCacheFn(records);
      } catch (err) {
        logger.warn(`Space-weather refresh failed (serving stale/empty cache): ${(err as Error).message}`);
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }

  function ensureFresh(): void {
    if (guard.shouldReload()) {
      const cache = readCacheFn();
      const map = new Map<string, SwpcDailyIndex>();
      for (const rec of cache?.records ?? []) map.set(rec.date, rec);
      byDate = map;
      logger.info(`Space-weather provider: ${map.size} daily records loaded, version=${guard.currentVersion() ?? 'unknown'}`);
    }

    const now = Date.now();
    if (now - lastFreshnessCheckMs >= FRESHNESS_CHECK_INTERVAL_MS) {
      lastFreshnessCheckMs = now;
      if (!isCacheFreshFn()) triggerBackgroundRefresh();
    }
  }

  function getField(_noradId: number, field: string, tMs: number): FieldValue {
    ensureFresh();
    const rec = byDate.get(dateKeyOf(tMs));
    if (!rec) return null;
    switch (field) {
      case 'solarFlux10cm': return rec.f107;
      case 'geomagneticAp': return rec.apIndex;
      case 'geomagneticKp': return rec.kpIndex;
      default: return null;
    }
  }

  return {
    id: 'space-weather',
    fields: SPACE_WEATHER_FIELDS,
    getField,
  };
}
