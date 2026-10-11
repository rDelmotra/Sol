import { useMemo } from 'react';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore } from '../../../store/useStore';
import { CATEGORY_LABEL, altitudeLabel, altitudeReading, elementOrbit, kindCode, kmStr, velStr } from '../format';
import { GlassPane } from '../primitives/GlassPane';
import { KV } from '../primitives/KV';
import { PaneHeader } from '../primitives/PaneHeader';

/**
 * IDENTITY card: name, category · program, class, altitude, velocity. Its own
 * leaf because the live altitude / speed change ~4×/s.
 */
export function IdentityPane({ selected, delay }: { selected: EnrichedTLEObject; delay: number }) {
  const liveAltitudeKm = useStore((s) => s.liveAltitudeKm);
  const liveSpeedKmS = useStore((s) => s.liveSpeedKmS);
  const meanAltKm = useMemo(() => elementOrbit(selected).meanAltKm, [selected]);
  const alt = altitudeReading(liveAltitudeKm, meanAltKm);

  return (
    <GlassPane delay={delay}>
      <PaneHeader label="IDENTITY" value={`NORAD ${selected.noradId}`} />
      <div style={{ padding: '12px' }}>
        <div style={{ fontSize: 13, fontFamily: 'var(--font-hud-mono)' }}>{selected.name}</div>
        <div style={{ marginTop: 2, fontSize: 10, color: 'var(--hud-text-dim)' }}>
          {CATEGORY_LABEL[selected.category] ?? 'Unknown'}
          {selected.program ? ` · ${selected.program}` : ''}
        </div>
        <div style={{ marginTop: 12 }}>
          <KV k="CLASS" v={kindCode(selected.objectType)} />
          <KV k={altitudeLabel(alt)} v={kmStr(alt?.km)} />
          <KV k="VELOCITY" v={velStr(liveSpeedKmS)} />
        </div>
      </div>
    </GlassPane>
  );
}
