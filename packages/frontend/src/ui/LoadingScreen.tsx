import { useState, useEffect } from 'react';
import { useStore, type LoadingPhase } from '../store/useStore';

const PHASE_MESSAGES: Record<LoadingPhase, string> = {
  fetching: 'Downloading catalog data...',
  initializing: 'Initializing propagation engine...',
  propagating: 'Computing orbital positions...',
  ready: '',
};

const PHASE_PROGRESS: Record<LoadingPhase, number> = {
  fetching: 33,
  initializing: 66,
  propagating: 90,
  ready: 100,
};

export function LoadingScreen() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const loadingError = useStore((s) => s.loadingError);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // A critical failure — even one that happens AFTER the app loaded — must
    // re-assert the overlay so the error is never invisible behind an unmounted
    // loading screen.
    if (loadingError) {
      setVisible(true);
      return;
    }
    if (loadingPhase === 'ready') {
      // Scene is already rendered behind the overlay — drop it immediately,
      // no fade (the 1s fade was pure perceived-load tax).
      setVisible(false);
    }
  }, [loadingPhase, loadingError]);

  if (!visible) return null;

  const progress = PHASE_PROGRESS[loadingPhase];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--ow-void)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <h1
        style={{
          fontFamily: 'var(--ow-font-display)',
          fontSize: '2rem',
          color: 'var(--ow-text-hi)',
          letterSpacing: '0.32em',
          marginBottom: '2.25rem',
          marginRight: '-0.32em',
          fontWeight: 400,
        }}
      >
        orbitwatch
      </h1>

      <div
        style={{
          width: '280px',
          height: '3px',
          background: 'var(--ow-stroke-strong)',
          borderRadius: 'var(--ow-r-pill)',
          overflow: 'hidden',
          marginBottom: '1.1rem',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            background: 'var(--ow-telemetry)',
            borderRadius: 'var(--ow-r-pill)',
            boxShadow: '0 0 12px -2px var(--ow-telemetry)',
            transition: 'width 0.4s var(--ow-ease)',
          }}
        />
      </div>

      <p
        style={{
          fontFamily: 'var(--ow-font-mono)',
          fontSize: '0.78rem',
          letterSpacing: '0.04em',
          color: 'var(--ow-text-lo)',
        }}
      >
        {loadingError ? (
          <span style={{ color: 'var(--ow-danger)' }}>{loadingError}</span>
        ) : (
          PHASE_MESSAGES[loadingPhase]
        )}
      </p>
    </div>
  );
}
