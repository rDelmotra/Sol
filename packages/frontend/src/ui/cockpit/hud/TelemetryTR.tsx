import { useMemo } from 'react';
import { useStore } from '../../../store/useStore';
import { altitudeReading, elementOrbit, groupInt, kindCode } from '../format';
import { HUD_CORNER_INSET } from '../layout';

/** Top-right corner: regime + altitude and id of the locked object. Nothing when nothing is locked. */
export function TelemetryTR() {
  const selected = useStore((s) => s.selectedSatellite);
  const liveAltitudeKm = useStore((s) => s.liveAltitudeKm);
  const meanAltKm = useMemo(() => (selected ? elementOrbit(selected).meanAltKm : null), [selected]);
  const alt = altitudeReading(liveAltitudeKm, meanAltKm);
  const altText = alt ? `${alt.live ? '' : 'MEAN '}${groupInt(alt.km)} KM` : '—';
  if (!selected) return null;

  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        right: HUD_CORNER_INSET,
        top: HUD_CORNER_INSET,
        textAlign: 'right',
        fontSize: 10,
        lineHeight: 1.625,
        fontFamily: 'var(--font-hud-mono)',
        color: 'var(--hud-text-dim)',
      }}
    >
      <div style={{ color: 'var(--hud-text)' }}>{`${selected.regime} · ${altText}`}</div>
      <div>{`${kindCode(selected.objectType)} ${selected.noradId}`}</div>
    </div>
  );
}
