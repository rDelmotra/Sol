import { useEffect, useState } from 'react';
import { useStore } from '../../store/useStore';
import { BUTTON_RESET } from './hudStyles';

/** How long the ↺ pulses after you first leave the live edge, ms. */
const PULSE_MS = 2600;

function ReturnIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 1 3 6.36" />
      <polyline points="3 22 3 16 9 16" />
    </svg>
  );
}

/**
 * ↺ return to present. Mounted only while displaced, even with the console
 * closed. Pulses for its first 2.6 s (the one moment the user needs to learn it
 * exists). When the pad's D-pad is parked on it (scrubFocusOnReset) it fills solid.
 */
export function ReturnToPresentButton() {
  const focusOnReset = useStore((s) => s.scrubFocusOnReset);
  const [pulse, setPulse] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setPulse(false), PULSE_MS);
    return () => clearTimeout(id);
  }, []);

  return (
    <button
      onClick={() => useStore.getState().returnToPresent()}
      title="Return to present"
      aria-label="Return to present"
      style={{
        ...BUTTON_RESET,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: 9999,
        color: focusOnReset ? 'var(--hud-sky-deep)' : 'var(--hud-warn)',
        background: focusOnReset ? 'var(--hud-warn)' : 'transparent',
        border: '1px solid oklch(0.82 0.14 55 / 0.45)',
        boxShadow: focusOnReset ? '0 0 10px 2px oklch(0.82 0.14 55 / 0.65)' : 'none',
        transition: 'background 140ms ease, box-shadow 140ms ease, color 140ms ease',
        animation: pulse && !focusOnReset ? 'hud-return-pulse 1.15s ease-in-out infinite' : 'none',
      }}
    >
      <ReturnIcon />
    </button>
  );
}
