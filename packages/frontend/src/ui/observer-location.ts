// ============================================================
// Observer location — pure acquisition + cache core (no React, no DOM).
//
// WHY THIS EXISTS: the working geolocation logic lives inside FilterPanel.tsx,
// which the cockpit HUD replaces (state/DECISIONS.md D8). Without it the cockpit
// would have no way to set an observer location, and the dome/radio engine
// behind it would be unreachable. This is that logic lifted out unchanged in
// behaviour, with two changes that make it testable under the repo's runner
// (`tsx --test`, .ts only, no jsdom):
//
//   1. Storage is injected (`LocationStore`) rather than reaching for the global
//      `localStorage`, which does not exist in a Node test process.
//   2. The acquisition sequence is a pure async function over injected deps
//      (`geolocate`, `store`, `now`) returning a LocationOutcome, instead of
//      calling React setters inline. The hook maps outcome → state.
//
// The acquisition policy itself is unchanged and deliberate: try high-accuracy
// first; on anything except a permission denial fall back to a low-accuracy fix
// that may be up to LOCATION_RETRY_MAX_AGE_MS stale; if both fail, fall back to
// a cached fix, but only while it is younger than OBSERVER_LOCATION_CACHE_MAX_AGE_MS
// — a day-old position would put the sky dome over the wrong horizon.
// ============================================================

export interface ObserverLocationValue {
  lat: number;
  lon: number;
  /** Kilometres above the ellipsoid. 0 when the fix carries no altitude. */
  alt: number;
}

export interface ObserverLocationCacheEnvelope extends ObserverLocationValue {
  savedAt: number;
}

/**
 * The slice of `Storage` the cache actually uses. Injected so the cache is
 * exercisable in a Node test with a Map-backed fake — `localStorage` is undefined
 * there, and the old code's `typeof localStorage === 'undefined'` guards meant the
 * cache silently no-opped rather than being testable.
 */
export interface LocationStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const OBSERVER_LOCATION_CACHE_KEY = 'orbitwatch:observerLocation:v1';
export const OBSERVER_LOCATION_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const LOCATION_RETRY_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * The ambient `localStorage`, or null where there isn't one (SSR, Node tests).
 *
 * The try/catch is not defensive padding: with third-party storage blocked,
 * Safari throws SecurityError on the `localStorage` property access itself, not
 * on the later get/set. Since this is invoked as a default argument — outside the
 * try/catch that guards every actual read and write — an unguarded throw here
 * would propagate out of functions documented as never throwing.
 */
export function defaultLocationStore(): LocationStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Map a browser fix onto our value type. Altitude is metres in, km out. */
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

/** Persist a fix. Never throws — a full/blocked quota must not break locating. */
export function cacheObserverLocation(
  location: ObserverLocationValue,
  store: LocationStore | null = defaultLocationStore(),
): void {
  if (!store) {
    return;
  }

  try {
    const payload: ObserverLocationCacheEnvelope = {
      ...location,
      savedAt: Date.now(),
    };
    store.setItem(OBSERVER_LOCATION_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore local cache write errors.
  }
}

/** Read a cached fix, or null if absent, unparseable, or missing/non-finite fields. */
export function readCachedObserverLocation(
  store: LocationStore | null = defaultLocationStore(),
): ObserverLocationCacheEnvelope | null {
  if (!store) {
    return null;
  }

  try {
    const raw = store.getItem(OBSERVER_LOCATION_CACHE_KEY);
    if (!raw) {
      return null;
    }

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

export function clearCachedObserverLocation(store: LocationStore | null = defaultLocationStore()): void {
  if (!store) {
    return;
  }

  try {
    store.removeItem(OBSERVER_LOCATION_CACHE_KEY);
  } catch {
    // Ignore local cache remove errors.
  }
}

/** Humanised age: "7 min", "3h", "3h 20m". Floors at 1 min. */
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
      return 'Live location unavailable (CoreLocation could not resolve position). Try again in a few seconds or move to an open-sky area.';
    case 3:
      return 'Location request timed out. Try again.';
    default:
      return `Unable to retrieve location: ${err.message}`;
  }
}

/**
 * What an acquisition attempt produced. `cached` still yields a usable location —
 * the message explains that it is not a live fix, and the caller applies it anyway.
 */
export type LocationOutcome =
  | { kind: 'live'; location: ObserverLocationValue }
  | { kind: 'cached'; location: ObserverLocationValue; message: string }
  | { kind: 'failed'; message: string };

export interface AcquireDeps {
  /** Wraps `navigator.geolocation.getCurrentPosition`. Rejects with GeolocationPositionError. */
  geolocate: (options: PositionOptions) => Promise<GeolocationPosition>;
  store?: LocationStore | null;
  /** Injectable clock so cache-staleness branches are testable. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Run the full acquisition policy. Pure over its deps — no React, no globals.
 * A successful live fix is written to the cache as a side effect on `store`.
 */
export async function acquireObserverLocation(deps: AcquireDeps): Promise<LocationOutcome> {
  const { geolocate } = deps;
  // `??` would be wrong here: `store: null` means "no storage", and every other
  // function in this file honours that via a default parameter (which fires only
  // on undefined). Coalescing would quietly hand an explicit null caller the real
  // localStorage instead.
  const store = deps.store === undefined ? defaultLocationStore() : deps.store;
  const now = deps.now ?? Date.now;

  try {
    let position: GeolocationPosition;
    try {
      position = await geolocate({
        enableHighAccuracy: true,
        timeout: 12_000,
        maximumAge: 0,
      });
    } catch (err) {
      const geoErr = err as GeolocationPositionError;
      if (geoErr.code === 1) {
        throw geoErr;
      }

      position = await geolocate({
        enableHighAccuracy: false,
        timeout: 15_000,
        maximumAge: LOCATION_RETRY_MAX_AGE_MS,
      });
    }

    const location = toObserverLocation(position);
    cacheObserverLocation(location, store);
    return { kind: 'live', location };
  } catch (err) {
    const cached = readCachedObserverLocation(store);
    if (cached) {
      const cacheAgeMs = now() - cached.savedAt;
      if (cacheAgeMs <= OBSERVER_LOCATION_CACHE_MAX_AGE_MS) {
        return {
          kind: 'cached',
          location: { lat: cached.lat, lon: cached.lon, alt: cached.alt },
          message: `Live location unavailable; using saved location (${new Date(cached.savedAt).toISOString().slice(11, 19)} UTC).`,
        };
      }

      clearCachedObserverLocation(store);
      return {
        kind: 'failed',
        message: `Live location unavailable and saved location is stale (${formatAge(cacheAgeMs)} old); not applied.`,
      };
    }

    if (err instanceof Error) {
      return { kind: 'failed', message: `Unable to retrieve location: ${err.message}` };
    }

    const geoErr = err as GeolocationPositionError;
    return { kind: 'failed', message: getLocationErrorMessage(geoErr) };
  }
}
