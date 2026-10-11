import { useMemo } from 'react';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { ageString, kindCode } from '../format';
import { GlassPane } from '../primitives/GlassPane';
import { KV } from '../primitives/KV';
import { ORBIT_DIAGRAM_H } from '../layout';
import { PaneBody } from '../primitives/PaneBody';
import { PaneHeader } from '../primitives/PaneHeader';
import type { PaneSlotProps } from '../primitives/PaneStack';
import { OrbitDiagram } from './OrbitDiagram';

/**
 * OBJECT SCAN card: the orbit diagram (ORBIT_DIAGRAM_H = 128 px slot) under a
 * scan sweep, then type, RCS and age.
 */
export function ObjectScanPane({ selected, delay = 0, fromLeft = false }: { selected: EnrichedTLEObject } & PaneSlotProps) {
  // Wall-clock age, fixed per lock: months do not need a clock subscription.
  const age = useMemo(() => ageString(selected.launchDate, Date.now()), [selected]);
  return (
    <GlassPane fromLeft={fromLeft} delay={delay}>
      <PaneHeader label="OBJECT SCAN" value={`NORAD ${selected.noradId}`} />
      <PaneBody>
        <div style={{ position: 'relative', margin: '0 auto', height: ORBIT_DIAGRAM_H, width: '100%' }}>
          <OrbitDiagram object={selected} />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'linear-gradient(180deg, transparent 40%, var(--hud-glow-tint) 50%, transparent 60%)',
              animation: 'hud-scan 3.4s linear infinite',
            }}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <KV k="TYPE" v={kindCode(selected.objectType)} />
          <KV k="RCS" v={selected.rcsSize ?? '—'} />
          <KV k="AGE" v={age ?? '—'} />
        </div>
      </PaneBody>
    </GlassPane>
  );
}
