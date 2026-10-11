import './cockpit.css';
import { AskBar } from './hud/AskBar';
import { AnalysisPanes } from './panes/AnalysisPanes';
import { CompassStrip } from './ground/CompassStrip';
import { ControlsSheet } from './controls/ControlsSheet';
import { Dock } from './dock/Dock';
import { EdgeArc } from './hud/EdgeArc';
import { FocusPanes } from './panes/FocusPanes';
import { HudErrorBoundary } from './primitives/HudErrorBoundary';
import { HudTitle } from './primitives/HudTitle';
import { ObjectDisc } from './hud/ObjectDisc';
import { PassReadout } from './ground/PassReadout';
import { Reticle } from './hud/Reticle';
import { TimeConsole } from './time/TimeConsole';
import { TelemetryBL } from './hud/TelemetryBL';
import { TelemetryTR } from './hud/TelemetryTR';
import { VignetteAndScan } from './primitives/VignetteAndScan';
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

      <HudErrorBoundary region="object disc">
        <ObjectDisc />
      </HudErrorBoundary>

      <HudErrorBoundary region="compass">
        <CompassStrip />
        <PassReadout />
      </HudErrorBoundary>

      <HudErrorBoundary region="edge arcs">
        <EdgeArc side="left" />
        <EdgeArc side="right" />
      </HudErrorBoundary>

      <HudErrorBoundary region="analysis panes">
        <AnalysisPanes />
      </HudErrorBoundary>
      <HudErrorBoundary region="focus panes">
        <FocusPanes />
      </HudErrorBoundary>

      <HudErrorBoundary region="time console">
        <TimeConsole />
      </HudErrorBoundary>

      <HudErrorBoundary region="telemetry">
        <TelemetryTR />
        <TelemetryBL />
      </HudErrorBoundary>

      <HudErrorBoundary region="ask bar">
        <AskBar />
      </HudErrorBoundary>

      <HudTitle />

      <HudErrorBoundary region="dock">
        <Dock />
      </HudErrorBoundary>

      <HudErrorBoundary region="controls sheet">
        <ControlsSheet />
      </HudErrorBoundary>
    </div>
  );
}
