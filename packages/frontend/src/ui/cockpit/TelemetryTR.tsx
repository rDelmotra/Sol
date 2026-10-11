import { useMemo } from 'react';
import { useStore } from '../../store/useStore';
import { altitudeReading, elementOrbit, groupInt, kindCode, syncStr } from './format';
import { HUD_CORNER_INSET } from './layout';

/** Top-right corner: regime + altitude of the lock (or catalog size), lock id, data sync time. */
export function TelemetryTR() {
  const selected = useStore((s) => s.selectedSatellite);
  const liveAltitudeKm = useStore((s) => s.liveAltitudeKm);
  const objectCount = useStore((s) => s.objectCount);
  const dataTimestamp = useStore((s) => s.dataTimestamp);
  const meanAltKm = useMemo(() => (selected ? elementOrbit(selected).meanAltKm : null), [selected]);
  const alt = altitudeReading(liveAltitudeKm, meanAltKm);
  const altText = alt ? `${alt.live ? '' : 'MEAN '}${groupInt(alt.km)} KM` : '—';

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
      <div style={{ color: 'var(--hud-text)' }}>
        {selected ? `${selected.regime} · ${altText}` : `SSA · ${objectCount.toLocaleString('en-US')} OBJ`}
      </div>
      <div>{selected ? `LOCK ${kindCode(selected.objectType)} ${selected.noradId}` : 'LOCK —'}</div>
      <div>SYNC {syncStr(dataTimestamp)}</div>
    </div>
  );
}
