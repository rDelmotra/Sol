import './cockpit.css';
import { HudErrorBoundary } from './HudErrorBoundary';
import { HudTitle } from './HudTitle';
import { Reticle } from './Reticle';
import { TelemetryBL } from './TelemetryBL';
import { TelemetryTR } from './TelemetryTR';
import { VignetteAndScan } from './VignetteAndScan';
import { useCockpitKeys } from './useCockpitKeys';

/**
 * The cockpit HUD root (state/DECISIONS.md D8). A click-through layer over the
 * globe. This component subscribes to nothing: each region reads only the
 * store keys it shows, so the clock ticking never re-renders the whole tree.
 * Each region has its own error boundary, so one fault hides one region.
 */
const ROOT_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  userSelect: 'none',
  pointerEvents: 'none',
  color: 'var(--hud-text)',
  fontFamily: 'var(--font-hud-sans)',
};

export default function CockpitHud() {
  useCockpitKeys();
  return (
    <div style={ROOT_STYLE}>
      <VignetteAndScan />

      <HudErrorBoundary region="reticle">
        <Reticle />
      </HudErrorBoundary>

      {/* Slot: time console (top-left, 24/24). Built in a separate step. */}

      <HudErrorBoundary region="telemetry">
        <TelemetryTR />
        <TelemetryBL />
      </HudErrorBoundary>

      {/* Slot: ask bar (bottom centre, above the dock). Built in a separate step. */}

      <HudTitle />
    </div>
  );
}
