import { pickCurrentPass } from '../../../sky/passes';
import { useStore } from '../../../store/useStore';
import { passReadoutModel } from './pass-readout';

/**
 * What is coming over, when and how high, or why there is nothing to show.
 * Top 66, centred, just under the compass strip. The pass is selected in the
 * store so a clock tick re-renders only when the picked pass (or its text)
 * changes; the clock itself is read here at ~4 Hz, which the countdown needs.
 */
const PANEL: React.CSSProperties = {
  position: 'absolute',
  top: 66,
  left: '50%',
  transform: 'translateX(-50%)',
  pointerEvents: 'none',
  borderRadius: 8,
  background: 'var(--hud-glass)',
  border: '1px solid var(--hud-glass-edge)',
  backdropFilter: 'blur(14px) saturate(120%)',
  WebkitBackdropFilter: 'blur(14px) saturate(120%)',
  boxShadow: 'var(--hud-inner-glow), var(--hud-drop-shadow)',
  padding: '8px 14px',
  fontFamily: 'var(--font-hud-mono)',
  color: 'var(--hud-text)',
  whiteSpace: 'nowrap',
  textAlign: 'center',
};

export function PassReadout() {
  const ready = useStore((s) => s.loadingPhase === 'ready');
  const vantage = useStore((s) => s.vantage);
  const passStatus = useStore((s) => s.passStatus);
  const name = useStore((s) => s.selectedSatellite?.name);
  const pass = useStore((s) => pickCurrentPass(s.nextPasses, s.simTimeMs));
  const placeName = useStore((s) => s.observerPlaceName);
  const nowMs = useStore((s) => s.simTimeMs);
  if (!ready) return null;

  const m = passReadoutModel({ vantage, passStatus, name, pass, nowMs, placeName });
  if (!m) return null;
  return (
    <div style={PANEL}>
      {m.title && <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--hud-text)', letterSpacing: '0.03em' }}>{m.title}</div>}
      <div
        style={{
          fontSize: 12,
          marginTop: 2,
          color: m.tone === 'good' ? 'var(--hud-good)' : 'var(--hud-text)',
          fontWeight: m.tone === 'good' ? 700 : undefined,
        }}
      >
        {m.primary}
      </div>
      {m.secondary && <div style={{ fontSize: 10, marginTop: 2, color: 'var(--hud-text-dim)' }}>{m.secondary}</div>}
    </div>
  );
}
