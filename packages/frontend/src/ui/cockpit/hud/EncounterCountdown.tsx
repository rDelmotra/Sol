import { useStore } from '../../../store/useStore';
import { formatMiss, formatObjectLabel, formatTcaClock } from '../../../data/encounter-format';
import { HUD_CORNER_INSET } from '../layout';

/**
 * "TCA in mm:ss" over the globe while a flyby is being watched, with the pair's
 * names and the server's miss distance. Neutral colours, no alarm styling.
 */
export function EncounterCountdown() {
  const id = useStore((s) => s.selectedEncounterId);
  const sat = useStore((s) => s.selectedSatellite);
  const list = useStore((s) => (s.selectedSatellite ? s.encountersByNorad[s.selectedSatellite.noradId] : undefined));
  const simTimeMs = useStore((s) => s.simTimeMs);
  if (id === null || !sat) return null;
  const e = list?.find((x) => x.id === id);
  if (!e) return null;
  const other = e.a.noradId === sat.noradId ? e.b : e.a;
  return (
    <div
      style={{
        position: 'absolute',
        top: HUD_CORNER_INSET,
        left: '50%',
        transform: 'translateX(-50%)',
        textAlign: 'center',
        fontFamily: 'var(--font-hud-mono)',
        color: 'var(--hud-text)',
        pointerEvents: 'none',
      }}
    >
      <div style={{ fontSize: 22, letterSpacing: '0.08em', textShadow: '0 0 12px var(--hud-arc-glow)' }}>
        {formatTcaClock(Date.parse(e.tca), simTimeMs)}
      </div>
      <div style={{ marginTop: 4, fontSize: 10, letterSpacing: '0.1em', color: 'var(--hud-text-dim)' }}>
        {formatObjectLabel(sat)} · {formatObjectLabel(other)} · {formatMiss(e.missKm)}
      </div>
    </div>
  );
}
