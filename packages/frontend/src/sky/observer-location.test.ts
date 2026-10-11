import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OBSERVER_LOCATION_CACHE_KEY,
  OBSERVER_LOCATION_CACHE_MAX_AGE_MS,
  LOCATION_RETRY_MAX_AGE_MS,
  acquireObserverLocation,
  cacheObserverLocation,
  clearCachedObserverLocation,
  formatAge,
  readCachedObserverLocation,
  toObserverLocation,
  type LocationStore,
} from './observer-location';

// Map-backed fake — mirrors the Storage interface without touching the DOM.
function makeStore(): LocationStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function makePosition(lat: number, lon: number, altitude: number | null): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lon,
      altitude,
      accuracy: 1,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON() {
        return this;
      },
    },
    timestamp: Date.now(),
    toJSON() {
      return this;
    },
  } as unknown as GeolocationPosition;
}

function permissionDeniedError(): GeolocationPositionError {
  return {
    code: 1,
    message: 'denied',
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

function positionUnavailableError(): GeolocationPositionError {
  return {
    code: 2,
    message: 'unavailable',
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe('observer-location: cache round-trip', () => {
  it('writes then reads back the same fix', () => {
    const store = makeStore();
    cacheObserverLocation({ lat: 51.5, lon: -0.12, alt: 0.03 }, store);
    const cached = readCachedObserverLocation(store);
    assert.ok(cached);
    assert.equal(cached!.lat, 51.5);
    assert.equal(cached!.lon, -0.12);
    assert.equal(cached!.alt, 0.03);
    assert.equal(typeof cached!.savedAt, 'number');
  });

  it('returns null when nothing is cached', () => {
    const store = makeStore();
    assert.equal(readCachedObserverLocation(store), null);
  });

  it('rejects a malformed envelope (missing field)', () => {
    const store = makeStore();
    store.setItem(OBSERVER_LOCATION_CACHE_KEY, JSON.stringify({ lat: 1, lon: 2 }));
    assert.equal(readCachedObserverLocation(store), null);
  });

  it('rejects a non-finite field', () => {
    const store = makeStore();
    store.setItem(
      OBSERVER_LOCATION_CACHE_KEY,
      JSON.stringify({ lat: NaN, lon: 2, alt: 0, savedAt: Date.now() }),
    );
    assert.equal(readCachedObserverLocation(store), null);
  });

  it('rejects unparseable JSON', () => {
    const store = makeStore();
    store.setItem(OBSERVER_LOCATION_CACHE_KEY, 'not json');
    assert.equal(readCachedObserverLocation(store), null);
  });

  it('clearCachedObserverLocation removes the entry', () => {
    const store = makeStore();
    cacheObserverLocation({ lat: 1, lon: 2, alt: 0 }, store);
    clearCachedObserverLocation(store);
    assert.equal(readCachedObserverLocation(store), null);
  });
});

describe('observer-location: toObserverLocation altitude conversion', () => {
  it('converts metres to kilometres', () => {
    const loc = toObserverLocation(makePosition(10, 20, 1500));
    assert.equal(loc.lat, 10);
    assert.equal(loc.lon, 20);
    assert.equal(loc.alt, 1.5);
  });

  it('defaults altitude to 0 when the fix carries none', () => {
    const loc = toObserverLocation(makePosition(10, 20, null));
    assert.equal(loc.alt, 0);
  });
});

describe('observer-location: formatAge boundaries', () => {
  it('formats sub-hour ages in minutes, floored at 1', () => {
    assert.equal(formatAge(1_000), '1 min');
    assert.equal(formatAge(7 * 60_000), '7 min');
    assert.equal(formatAge(59 * 60_000), '59 min');
  });

  it('formats exact hours with no minutes suffix', () => {
    assert.equal(formatAge(60 * 60_000), '1h');
    assert.equal(formatAge(3 * 60 * 60_000), '3h');
  });

  it('formats hours + minutes', () => {
    assert.equal(formatAge(3 * 60 * 60_000 + 20 * 60_000), '3h 20m');
  });
});

describe('observer-location: acquireObserverLocation policy', () => {
  it('high-accuracy success does not retry', async () => {
    const store = makeStore();
    let calls = 0;
    const outcome = await acquireObserverLocation({
      geolocate: async (options) => {
        calls += 1;
        assert.equal(options.enableHighAccuracy, true);
        return makePosition(1, 2, 100);
      },
      store,
    });
    assert.equal(calls, 1);
    assert.equal(outcome.kind, 'live');
    if (outcome.kind === 'live') {
      assert.equal(outcome.location.lat, 1);
      assert.equal(outcome.location.alt, 0.1);
    }
    // Successful live fix is cached as a side effect.
    assert.ok(readCachedObserverLocation(store));
  });

  it('permission-denied does not retry', async () => {
    const store = makeStore();
    let calls = 0;
    const outcome = await acquireObserverLocation({
      geolocate: async () => {
        calls += 1;
        throw permissionDeniedError();
      },
      store,
    });
    assert.equal(calls, 1);
    assert.equal(outcome.kind, 'failed');
  });

  it('non-permission failure retries with low-accuracy options', async () => {
    const store = makeStore();
    const calls: PositionOptions[] = [];
    const outcome = await acquireObserverLocation({
      geolocate: async (options) => {
        calls.push(options);
        if (calls.length === 1) {
          throw positionUnavailableError();
        }
        return makePosition(5, 6, null);
      },
      store,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].enableHighAccuracy, true);
    assert.equal(calls[1].enableHighAccuracy, false);
    assert.equal(calls[1].maximumAge, LOCATION_RETRY_MAX_AGE_MS);
    assert.equal(outcome.kind, 'live');
  });

  it('both attempts fail + fresh cache => cached outcome', async () => {
    const store = makeStore();
    const now = 1_000_000_000;
    cacheObserverLocation({ lat: 9, lon: 10, alt: 0.2 }, store);
    // Force the cached savedAt to be recent relative to `now`.
    const cachedRaw = JSON.parse(store.getItem(OBSERVER_LOCATION_CACHE_KEY)!);
    cachedRaw.savedAt = now - 1000;
    store.setItem(OBSERVER_LOCATION_CACHE_KEY, JSON.stringify(cachedRaw));

    const outcome = await acquireObserverLocation({
      geolocate: async () => {
        throw positionUnavailableError();
      },
      store,
      now: () => now,
    });

    assert.equal(outcome.kind, 'cached');
    if (outcome.kind === 'cached') {
      assert.equal(outcome.location.lat, 9);
      assert.match(outcome.message, /using saved location/);
    }
  });

  it('both attempts fail + stale cache => failed and cache cleared', async () => {
    const store = makeStore();
    const now = 1_000_000_000;
    cacheObserverLocation({ lat: 9, lon: 10, alt: 0.2 }, store);
    const cachedRaw = JSON.parse(store.getItem(OBSERVER_LOCATION_CACHE_KEY)!);
    cachedRaw.savedAt = now - (OBSERVER_LOCATION_CACHE_MAX_AGE_MS + 1000);
    store.setItem(OBSERVER_LOCATION_CACHE_KEY, JSON.stringify(cachedRaw));

    const outcome = await acquireObserverLocation({
      geolocate: async () => {
        throw positionUnavailableError();
      },
      store,
      now: () => now,
    });

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind === 'failed') {
      assert.match(outcome.message, /stale/);
    }
    assert.equal(readCachedObserverLocation(store), null);
  });

  it('both attempts fail + no cache => failed', async () => {
    const store = makeStore();
    const outcome = await acquireObserverLocation({
      geolocate: async () => {
        throw positionUnavailableError();
      },
      store,
    });
    assert.equal(outcome.kind, 'failed');
  });
});
