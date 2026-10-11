// Thin React wrapper over the pure acquisition core in ../observer-location.ts.
// Owns only what React must: the in-flight flag, the last status message, and
// publishing the accepted fix to the store. Policy stays in the tested core.
import { useCallback, useState } from 'react';
import { useStore } from '../../store/useStore';
import { acquireObserverLocation, defaultLocationStore } from '../observer-location';

function geolocateOnce(options: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

export interface UseObserverLocation {
  /** True while an acquisition attempt is in flight. */
  isLocating: boolean;
  /** Note about the last attempt (failure, or a cached-fix fallback), else null. */
  statusMessage: string | null;
  /** True when the browser exposes a geolocation API at all. */
  supported: boolean;
  /** Start an acquisition. No-op while one is in flight. */
  requestLocation: () => Promise<void>;
}

export function useObserverLocation(): UseObserverLocation {
  const [isLocating, setIsLocating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const supported = typeof navigator !== 'undefined' && !!navigator.geolocation;

  const requestLocation = useCallback(async () => {
    if (isLocating) return;
    if (!supported) {
      setStatusMessage('Geolocation is not supported by your browser.');
      return;
    }
    setIsLocating(true);
    setStatusMessage(null);
    try {
      const outcome = await acquireObserverLocation({ geolocate: geolocateOnce, store: defaultLocationStore() });
      if (outcome.kind === 'failed') {
        setStatusMessage(outcome.message);
      } else {
        useStore.getState().setObserverLocation(outcome.location);
        setStatusMessage(outcome.kind === 'cached' ? outcome.message : null);
      }
    } finally {
      setIsLocating(false);
    }
  }, [isLocating, supported]);

  return { isLocating, statusMessage, supported, requestLocation };
}
