import { Suspense, lazy, useEffect, useRef } from 'react';
import type { Engine } from './engine/Engine';
import { LoadingScreen } from './ui/LoadingScreen';
import { useStore } from './store/useStore';

// Post-`ready` overlay UI — none of it renders until loadingPhase === 'ready',
// so it's split out of the first-paint chunk and streamed in at mount. Named
// exports are mapped to default for React.lazy.
const TopBar = lazy(() => import('./ui/TopBar').then((m) => ({ default: m.TopBar })));
const InfoCard = lazy(() => import('./ui/InfoCard').then((m) => ({ default: m.InfoCard })));
const AnswerCard = lazy(() => import('./ui/AnswerCard').then((m) => ({ default: m.AnswerCard })));
const Tooltip = lazy(() => import('./ui/Tooltip').then((m) => ({ default: m.Tooltip })));
const ClusterPopup = lazy(() => import('./ui/ClusterPopup').then((m) => ({ default: m.ClusterPopup })));
const TimeScrubber = lazy(() =>
  import('./ui/TimeScrubber').then((m) => ({ default: m.TimeScrubber })),
);
const DevOverlay = lazy(() => import('./ui/DevOverlay').then((m) => ({ default: m.DevOverlay })));
const CompassStrip = lazy(() =>
  import('./ui/CompassStrip').then((m) => ({ default: m.CompassStrip })),
);

function DsoLabels() {
  const labelPositions = useStore((s) => s.dsoLabelPositions);
  const loadingPhase = useStore((s) => s.loadingPhase);
  if (loadingPhase !== 'ready') return null;

  return (
    <>
      {labelPositions.map((label) => {
        if (!label.visible) return null;
        return (
          <div
            key={label.dsoId}
            style={{
              position: 'absolute',
              left: label.screenX + 10,
              top: label.screenY - 6,
              color: 'var(--ow-telemetry)',
              fontFamily: 'var(--ow-font-mono)',
              fontSize: '11px',
              fontWeight: 500,
              letterSpacing: '0.05em',
              pointerEvents: 'none',
              textShadow: '0 0 8px var(--ow-telemetry-soft), 0 1px 3px rgba(0,0,0,0.9)',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            {label.name}
          </div>
        );
      })}
    </>
  );
}

function ResetViewButton() {
  const cameraMode = useStore((s) => s.cameraMode);
  const triggerResetCamera = useStore((s) => s.triggerResetCamera);
  const loadingPhase = useStore((s) => s.loadingPhase);

  if (loadingPhase !== 'ready' || cameraMode === 'returning') return null;

  return (
    <button
      className="ow-pill"
      onClick={() => triggerResetCamera?.()}
      style={{
        position: 'absolute',
        bottom: 16,
        right: 16,
        pointerEvents: 'auto',
      }}
    >
      Reset view
    </button>
  );
}

function HudDimGroup({ children }: { children: React.ReactNode }) {
  // Modal focus: dim the rest of the HUD while the time scrubber is open.
  const dim = useStore((s) => s.scrubberMode);
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        opacity: dim ? 0.25 : 1,
        transition: 'opacity 0.3s ease',
      }}
    >
      {children}
    </div>
  );
}

const DOCK_WIDTH = 340;

/**
 * The bridge's context dock — pushes the canvas left instead of floating over
 * it. Auto behavior: collapsed to nothing when there is no selection and no
 * analytic answer (the deep field keeps the full viewport); slides open when
 * the shell has something to say. The Engine's canvas ResizeObserver picks up
 * the reflow, so the 3D view re-centers in the remaining space.
 */
function RightDock() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const selectedSatellite = useStore((s) => s.selectedSatellite);
  const selectedDso = useStore((s) => s.selectedDso);
  const analyticAnswer = useStore((s) => s.analyticAnswer);

  const open =
    loadingPhase === 'ready' && Boolean(selectedSatellite || selectedDso || analyticAnswer);

  return (
    <div
      className="ow-dock"
      data-open={open ? 'true' : 'false'}
      style={{ width: open ? DOCK_WIDTH : 0 }}
    >
      {/* Fixed inner width so content doesn't squish during the slide. */}
      <div
        className="ow-scroll"
        style={{
          width: DOCK_WIDTH,
          height: '100%',
          overflowY: 'auto',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <AnswerCard />
        <InfoCard />
      </div>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Lazy-load the Engine (and three.js) so it's out of the first-paint chunk.
    let engine: Engine | null = null;
    let cancelled = false;

    import('./engine/Engine').then(({ Engine }) => {
      // Guard the StrictMode double-mount: if the effect was torn down before
      // the import resolved, don't construct an orphaned (leaking) Engine.
      if (cancelled || !canvasRef.current) return;
      engine = new Engine(canvasRef.current);
      engineRef.current = engine;
      engine.start();
    });

    return () => {
      cancelled = true;
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <Suspense fallback={null}>
        <TopBar />
      </Suspense>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Viewport zone — the canvas plus everything anchored to it. */}
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <canvas
            ref={canvasRef}
            style={{ display: 'block', width: '100%', height: '100%' }}
          />
          <Suspense fallback={null}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
              }}
            >
              <HudDimGroup>
                <DsoLabels />
                <CompassStrip />
                <ResetViewButton />
              </HudDimGroup>
              <TimeScrubber />
            </div>
          </Suspense>
        </div>
        <Suspense fallback={null}>
          <RightDock />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <Tooltip />
        <ClusterPopup />
        {import.meta.env.DEV && <DevOverlay />}
      </Suspense>
      <LoadingScreen />
    </div>
  );
}
