import { useObserverLocation } from '../../hooks/useObserverLocation';
import { useStore } from '../../../store/useStore';
import { latLonStr } from './dock-modes';
import { DOCK_BLUE, DOCK_LABEL } from './dock-styles';
import { DOCK_H, LOCATION_POPOVER_GAP, LOCATION_POPOVER_W } from '../layout';

/**
 * The pin's popover: current coordinates and a GPS button. Opaque, no blur
 * (a nested backdrop-filter paints nothing in Chromium). Coordinates only:
 * there is no place-name lookup yet.
 */
export function LocationPopover() {
  const location = useStore((s) => s.observerLocation);
  const { isLocating, statusMessage, supported, requestLocation } = useObserverLocation();
  const busy = !supported || isLocating;

  return (
    <div
      role="dialog"
      aria-label="Location"
      style={{
        position: 'absolute',
        right: 0,
        bottom: DOCK_H + LOCATION_POPOVER_GAP,
        width: LOCATION_POPOVER_W,
        padding: 12,
        background: 'oklch(0.1 0.02 250 / 0.94)',
        border: '1px solid var(--hud-glass-edge)',
        borderRadius: 4,
      }}
    >
      <div style={{ ...DOCK_LABEL, marginBottom: 8, display: 'block' }}>LOCATION</div>
      {location && (
        <div style={{ marginBottom: 10, color: DOCK_BLUE, fontSize: 10, letterSpacing: '0.1em', lineHeight: 1.6 }}>
          <div style={{ opacity: 0.8 }}>{latLonStr(location.lat, location.lon)}</div>
        </div>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void requestLocation()}
        style={{
          appearance: 'none',
          width: '100%',
          padding: '6px 0',
          background: 'none',
          border: '1px solid var(--hud-glass-edge)',
          borderRadius: 3,
          fontFamily: 'var(--font-hud-mono)',
          fontSize: 9,
          letterSpacing: '0.16em',
          color: 'var(--hud-text)',
          cursor: 'pointer',
          opacity: busy ? 0.5 : 1,
        }}
      >
        {isLocating ? 'LOCATING…' : location ? 'UPDATE FROM GPS' : 'USE MY LOCATION'}
      </button>
      {statusMessage && (
        <div style={{ marginTop: 8, fontSize: 9, lineHeight: 1.5, color: 'var(--hud-warn)' }}>{statusMessage}</div>
      )}
    </div>
  );
}
