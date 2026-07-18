import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useStore } from '../../../store/useStore';
import type { VisibilityMode } from '../../../store/useStore';
import { Pill } from '../../primitives';
import {
  Toggle,
  geolocateOnce, toObserverLocation, cacheObserverLocation,
  readCachedObserverLocation, clearCachedObserverLocation,
  formatAge, getLocationErrorMessage, LOCATION_RETRY_MAX_AGE_MS,
  OBSERVER_LOCATION_CACHE_MAX_AGE_MS,
  lensSectionTitleStyle,
} from '../shared';

const PERSPECTIVE_MODES: readonly VisibilityMode[] = ['all', 'radio', 'dome'];

function perspectiveLabel(mode: VisibilityMode): string {
  return mode === 'all' ? 'Global' : mode === 'radio' ? 'Radio Pass' : 'Sky Dome';
}

const switchRowStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
};

const observerBlockStyle: CSSProperties = {
  marginTop: 12,
  paddingTop: 12,
  borderTop: '1px solid var(--ow-stroke)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const primaryLocateButtonStyle: CSSProperties = {
  background: 'var(--ow-perceptor-soft)',
  border: '1px solid var(--ow-perceptor-line)',
  color: 'var(--ow-perceptor)',
  padding: '6px 12px',
  borderRadius: 6,
  fontFamily: 'var(--ow-font-display)',
  fontSize: 11,
};

const updateLocationButtonStyle: CSSProperties = {
  alignSelf: 'flex-start',
  background: 'transparent',
  border: 'none',
  color: 'var(--ow-perceptor)',
  padding: 0,
  fontFamily: 'var(--ow-font-display)',
  fontSize: 10,
};

/**
 * "Perspective" section of the Lens sheet — the Global / Radio Pass / Sky Dome
 * view switch, plus (when a non-Global perspective is active) the observer
 * location panel: two-tier geolocation attempt, cached-location fallback, and
 * the Show Horizon Dome toggle. Ported verbatim from TopTaskbar's old
 * "Perspective Switch" block + `PerspectiveSubMenu` — only the container is
 * restyled for the sheet's normal document flow (no absolute positioning).
 */
export function PerspectiveSection() {
  const visibilityMode = useStore((s) => s.visibilityMode);
  const setVisibilityMode = useStore((s) => s.setVisibilityMode);
  const observerLocation = useStore((s) => s.observerLocation);
  const setObserverLocation = useStore((s) => s.setObserverLocation);
  const showObserverDome = useStore((s) => s.showObserverDome);
  const setShowObserverDome = useStore((s) => s.setShowObserverDome);

  const [isLocating, setIsLocating] = useState(false);
  const [locationStatusMessage, setLocationStatusMessage] = useState<string | null>(null);

  const handleRequestLocation = async () => {
    setIsLocating(true);
    setLocationStatusMessage(null);
    try {
      let position: GeolocationPosition;
      try {
        position = await geolocateOnce({
          enableHighAccuracy: true,
          timeout: 12_000,
          maximumAge: 0,
        });
      } catch (err) {
        const geoErr = err as GeolocationPositionError;
        if (geoErr.code === 1) throw geoErr;
        position = await geolocateOnce({
          enableHighAccuracy: false,
          timeout: 15_000,
          maximumAge: LOCATION_RETRY_MAX_AGE_MS,
        });
      }

      const location = toObserverLocation(position);
      cacheObserverLocation(location);
      setObserverLocation(location);
      setLocationStatusMessage(null);
    } catch (err) {
      const cached = readCachedObserverLocation();
      if (cached) {
        const cacheAgeMs = Date.now() - cached.savedAt;
        if (cacheAgeMs <= OBSERVER_LOCATION_CACHE_MAX_AGE_MS) {
          setObserverLocation({ lat: cached.lat, lon: cached.lon, alt: cached.alt });
          setLocationStatusMessage(
            `Live location unavailable; using saved location (${new Date(cached.savedAt).toISOString().slice(11, 19)} UTC).`,
          );
        } else {
          clearCachedObserverLocation();
          setLocationStatusMessage(
            `Live location unavailable and saved location is stale (${formatAge(cacheAgeMs)} old); not applied.`,
          );
        }
      } else {
        if (err instanceof Error) {
          setLocationStatusMessage(`Unable to retrieve location: ${err.message}`);
        } else {
          const geoErr = err as GeolocationPositionError;
          setLocationStatusMessage(getLocationErrorMessage(geoErr));
        }
      }
    } finally {
      setIsLocating(false);
    }
  };

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={lensSectionTitleStyle}>View</div>

      <div style={switchRowStyle}>
        {PERSPECTIVE_MODES.map((mode) => (
          <Pill
            key={mode}
            on={visibilityMode === mode}
            onClick={() => setVisibilityMode(mode)}
            style={{ flex: 1, justifyContent: 'center' }}
          >
            {perspectiveLabel(mode)}
          </Pill>
        ))}
      </div>

      {visibilityMode !== 'all' && (
        <div style={observerBlockStyle}>
          {observerLocation === null ? (
            <>
              <button
                type="button"
                onClick={() => void handleRequestLocation()}
                disabled={isLocating}
                style={{ ...primaryLocateButtonStyle, cursor: isLocating ? 'not-allowed' : 'pointer', opacity: isLocating ? 0.6 : 1 }}
              >
                {isLocating ? 'Locating...' : '📍 Use My Location'}
              </button>
              {locationStatusMessage && (
                <div style={{ fontSize: 10, color: 'var(--ow-danger)', lineHeight: 1.3, fontFamily: 'var(--ow-font-display)' }}>
                  {locationStatusMessage}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 10, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)' }}>
                  Lat: {observerLocation.lat.toFixed(2)}°
                </div>
                <div style={{ fontSize: 10, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-mono)' }}>
                  Lon: {observerLocation.lon.toFixed(2)}°
                </div>
              </div>

              <button
                type="button"
                onClick={() => void handleRequestLocation()}
                disabled={isLocating}
                style={{ ...updateLocationButtonStyle, cursor: isLocating ? 'not-allowed' : 'pointer', opacity: isLocating ? 0.6 : 1 }}
              >
                {isLocating ? 'Updating location...' : '↻ Update location'}
              </button>
              {locationStatusMessage && (
                <div style={{ fontSize: 10, color: 'var(--ow-warn)', lineHeight: 1.3, fontFamily: 'var(--ow-font-display)' }}>
                  {locationStatusMessage}
                </div>
              )}

              <div style={{ height: 1, background: 'var(--ow-stroke)', margin: '4px 0' }} />

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--ow-text-mid)', fontFamily: 'var(--ow-font-display)', flex: 1 }}>
                  Show Horizon Dome
                </span>
                <Toggle on={showObserverDome} onToggle={() => setShowObserverDome(!showObserverDome)} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
