import { Component, useEffect, useRef, type ReactNode } from 'react';
import type { Engine } from '../engine/Engine';
import { LoadingScreen } from '../ui/LoadingScreen';
import CockpitHud from './CockpitHud';

/* Cockpit HUD overlaid on the REAL OrbitWatch engine.
 *
 * Mounts the actual Three.js Engine (Earth + starfield + live catalog) and layers
 * the wired cockpit chrome on top. The HUD reads real store state; the engine is
 * unchanged. This is the app's UI now (App.tsx renders it). */

/* Keep a HUD render error from ever black-holing the globe: the boundary swallows
 * it, logs it, and leaves the canvas + boot overlay visible underneath. */
class HudErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[cockpit HUD] render error — HUD hidden, globe kept:', err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function CockpitOverlayApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Lazy-load the Engine (three.js) exactly like App.tsx, with the same
    // StrictMode double-mount guard so we never leak an orphaned Engine.
    let engine: Engine | null = null;
    let cancelled = false;

    import('../engine/Engine').then(({ Engine }) => {
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
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      <HudErrorBoundary>
        <CockpitHud overlay />
      </HudErrorBoundary>
      {/* Real boot overlay: covers the scene until the first propagated positions
       * arrive (loadingPhase → 'ready'), then unmounts. Shows the honest error if
       * the catalog fetch fails. */}
      <LoadingScreen />
    </div>
  );
}
