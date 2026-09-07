import { Suspense, lazy, useEffect, useRef } from 'react';
import type { Engine } from './engine/Engine';
import { LoadingScreen } from './ui/LoadingScreen';
import { useStore } from './store/useStore';

// Post-`ready` overlay UI — none of it renders until loadingPhase === 'ready',
// so it's split out of the first-paint chunk and streamed in at mount. Named
// exports are mapped to default for React.lazy.
const HUD = lazy(() => import('./ui/HUD').then((m) => ({ default: m.HUD })));
const FilterPanel = lazy(() => import('./ui/FilterPanel').then((m) => ({ default: m.FilterPanel })));
const SearchBar = lazy(() => import('./ui/SearchBar').then((m) => ({ default: m.SearchBar })));
const InfoCard = lazy(() => import('./ui/InfoCard').then((m) => ({ default: m.InfoCard })));
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
              color: '#00BCD4',
              fontFamily: 'monospace',
              fontSize: '11px',
              fontWeight: 500,
              letterSpacing: '0.05em',
              pointerEvents: 'none',
              textShadow: '0 0 6px rgba(0,188,212,0.7), 0 1px 3px rgba(0,0,0,0.9)',
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
      onClick={() => triggerResetCamera?.()}
      style={{
        position: 'absolute',
        bottom: 16,
        right: 16,
        padding: '6px 12px',
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 6,
        color: 'rgba(255, 255, 255, 0.7)',
        fontFamily: 'monospace',
        fontSize: '11px',
        cursor: 'pointer',
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
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      <Suspense fallback={null}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        >
          <HudDimGroup>
            <HUD />
            <FilterPanel />
            <div
              style={{
                position: 'absolute',
                top: 16,
                right: 16,
                width: 280,
                display: 'flex',
                flexDirection: 'column',
                pointerEvents: 'none',
                zIndex: 10,
              }}
            >
              <SearchBar />
              <InfoCard />
            </div>
            <DsoLabels />
            <CompassStrip />
            <ResetViewButton />
          </HudDimGroup>
          <TimeScrubber />
        </div>
        <Tooltip />
        <ClusterPopup />
        {import.meta.env.DEV && <DevOverlay />}
      </Suspense>
      <LoadingScreen />
    </div>
  );
}
