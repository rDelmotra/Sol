import type { CatalogType, OrbitalRegime } from '../../data/types';
import type { OrbitalStatus, Purpose, SectorFilterKey } from '../../data/metadata-types';

export const TYPE_KEYS: CatalogType[] = ['satellite', 'rocket_body', 'debris', 'unknown', 'deep_space'];
export const TYPE_LABELS: Record<CatalogType, string> = {
  satellite: 'Payload',
  rocket_body: 'Rocket Body',
  debris: 'Debris',
  unknown: 'Unknown',
  deep_space: 'Deep Space',
};

export const STATUS_KEYS: OrbitalStatus[] = ['in_orbit', 'decayed', 'deorbited', 'beyond_earth', 'exploded', 'unknown'];
export const SECTOR_KEYS: SectorFilterKey[] = ['commercial', 'government', 'military', 'civil', 'unspecified'];
export const PURPOSE_KEYS: Purpose[] = [
  'communications', 'earth_observation', 'navigation', 'technology_dev',
  'space_science', 'space_observation', 'surveillance', 'meteorological', 'other',
];
export const REGIME_KEYS: OrbitalRegime[] = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER'];
export const REGIME_LABELS: Record<OrbitalRegime, string> = {
  LEO: 'LEO', MEO: 'MEO', GEO: 'GEO', HEO: 'HEO', OTHER: 'Other',
};

// Extracted from original panel
export const OBSERVER_LOCATION_CACHE_KEY = 'orbitwatch:observerLocation:v1';
export const OBSERVER_LOCATION_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const LOCATION_RETRY_MAX_AGE_MS = 30 * 60 * 1000;

export interface ObserverLocationValue {
  lat: number;
  lon: number;
  alt: number;
}

export interface ObserverLocationCacheEnvelope extends ObserverLocationValue {
  savedAt: number;
}

export function geolocateOnce(options: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

export function toObserverLocation(position: GeolocationPosition): ObserverLocationValue {
  const altitudeMeters = position.coords.altitude;
  const altitudeKm =
    typeof altitudeMeters === 'number' && Number.isFinite(altitudeMeters)
      ? altitudeMeters / 1000
      : 0;
  return {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    alt: altitudeKm,
  };
}

export function cacheObserverLocation(location: ObserverLocationValue): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: ObserverLocationCacheEnvelope = {
      ...location,
      savedAt: Date.now(),
    };
    localStorage.setItem(OBSERVER_LOCATION_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore local cache write errors.
  }
}

export function clearCachedObserverLocation(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(OBSERVER_LOCATION_CACHE_KEY);
  } catch {
    // Ignore local cache remove errors.
  }
}

export function readCachedObserverLocation(): ObserverLocationCacheEnvelope | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(OBSERVER_LOCATION_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<ObserverLocationCacheEnvelope>;
    if (
      typeof parsed.lat !== 'number'
      || typeof parsed.lon !== 'number'
      || typeof parsed.alt !== 'number'
      || typeof parsed.savedAt !== 'number'
      || !Number.isFinite(parsed.lat)
      || !Number.isFinite(parsed.lon)
      || !Number.isFinite(parsed.alt)
      || !Number.isFinite(parsed.savedAt)
    ) {
      return null;
    }

    return {
      lat: parsed.lat,
      lon: parsed.lon,
      alt: parsed.alt,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export function formatAge(ms: number): string {
  const totalMinutes = Math.max(1, Math.floor(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function getLocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case 1:
      return 'Location permission denied. Enable browser + system location permissions.';
    case 2:
      return 'Live location unavailable. Try again in a few seconds or move to an open-sky area.';
    case 3:
      return 'Location request timed out. Try again.';
    default:
      return `Unable to retrieve location: ${err.message}`;
  }
}

// Toggle moved to the primitives layer (design-token driven, with hover/focus).
// Re-exported here so existing `./Lens/shared` imports keep working.
export { Toggle } from '../primitives/Toggle';
