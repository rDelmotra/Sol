import { Suspense, lazy, useEffect, useRef } from 'react';
import type { Engine } from './engine/Engine';
import { LoadingScreen } from './ui/LoadingScreen';
import { useNextPasses } from './ui/hooks/useNextPasses';
import { HudErrorBoundary } from './ui/cockpit/HudErrorBoundary';

// The cockpit HUD (state/DECISIONS.md D8) replaces the old overlay. Split out
// of the first-paint chunk like the old overlay was.
const CockpitHud = lazy(() => import('./ui/cockpit/CockpitHud'));
// Ground-mode compass: the spike kept it beside the cockpit (self-gated on the dome view).
const CompassStrip = lazy(() =>
  import('./ui/CompassStrip').then((m) => ({ default: m.CompassStrip })),
);
const DevOverlay = lazy(() => import('./ui/DevOverlay').then((m) => ({ default: m.DevOverlay })));

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  useNextPasses(); // pass plan for the arc + readout (store-only, no engine import)

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
        <CockpitHud />
        <HudErrorBoundary region="compass">
          <CompassStrip />
        </HudErrorBoundary>
        {import.meta.env.DEV && <DevOverlay />}
      </Suspense>
      <LoadingScreen />
    </div>
  );
}
