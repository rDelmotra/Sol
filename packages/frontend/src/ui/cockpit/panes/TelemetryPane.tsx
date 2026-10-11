import { useMemo } from 'react';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore } from '../../../store/useStore';
import { GlassPane } from '../primitives/GlassPane';
import { KV } from '../primitives/KV';
import { PaneHeader } from '../primitives/PaneHeader';
import {
  altitudeLabel,
  altitudeReading,
  degStr,
  elementOrbit,
  escapeFraction,
  kmStr,
  kmStr3,
  velStr3,
} from '../format';

/**
 * TELEMETRY card. LIVE = the Engine's SGP4 state (3 decimals). Without it the
 * header reads MEAN, altitude is the elements' mean altitude ("MEAN ALT") and
 * velocity is a dash. The bar is the live speed as a share of the local escape
 * speed (format.ts escapeFraction), a real ratio; the spike's "% of 7.9 km/s"
 * is gone. Its own leaf: it changes ~4×/s.
 */
export function TelemetryPane({ selected, delay }: { selected: EnrichedTLEObject; delay: number }) {
  const liveAltitudeKm = useStore((s) => s.liveAltitudeKm);
  const liveSpeedKmS = useStore((s) => s.liveSpeedKmS);
  const orbit = useMemo(() => elementOrbit(selected), [selected]);
  const alt = altitudeReading(liveAltitudeKm, orbit.meanAltKm);
  const live = alt?.live ?? false;
  const frac = escapeFraction(liveSpeedKmS, liveAltitudeKm);

  return (
    <GlassPane fromLeft={false} delay={delay}>
      <PaneHeader label="TELEMETRY" value={live ? 'LIVE' : 'MEAN'} />
      <div style={{ padding: '12px' }}>
        <KV k={altitudeLabel(alt)} v={live ? kmStr3(alt?.km) : kmStr(alt?.km)} />
        <KV k="INCL" v={degStr(orbit.inclination)} />
        <KV k="VELOCITY" v={velStr3(liveSpeedKmS)} />
        <div
          style={{
            marginTop: 8,
            height: 4,
            width: '100%',
            overflow: 'hidden',
            borderRadius: 9999,
            background: 'var(--hud-arc-dim)',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${(frac ?? 0) * 100}%`,
              background: 'linear-gradient(90deg, oklch(0.85 0.12 200), oklch(0.85 0.16 55))',
            }}
          />
        </div>
        <div
          style={{
            marginTop: 4,
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 9,
            color: 'var(--hud-text-dim)',
            fontFamily: 'var(--font-hud-mono)',
          }}
        >
          <span>OF ESCAPE VELOCITY</span>
          <span>{frac !== null ? `${Math.round(frac * 100)}%` : '—'}</span>
        </div>
      </div>
    </GlassPane>
  );
}
