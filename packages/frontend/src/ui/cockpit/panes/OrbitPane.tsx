import { useMemo } from 'react';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { degStr, elementOrbit, kmStr, minStr } from '../format';
import { GlassPane } from '../primitives/GlassPane';
import { KV } from '../primitives/KV';
import { PaneBody } from '../primitives/PaneBody';
import { PaneHeader } from '../primitives/PaneHeader';
import type { PaneSlotProps } from '../primitives/PaneStack';

/** ORBIT card: apogee, perigee, inclination, period from the lock's elements. */
export function OrbitPane({ selected, delay = 0, fromLeft = true }: { selected: EnrichedTLEObject } & PaneSlotProps) {
  const orbit = useMemo(() => elementOrbit(selected), [selected]);
  return (
    <GlassPane fromLeft={fromLeft} delay={delay}>
      <PaneHeader label="ORBIT" value={selected.regime} />
      <PaneBody>
        <KV k="APOGEE" v={kmStr(orbit.apogee)} />
        <KV k="PERIGEE" v={kmStr(orbit.perigee)} />
        <KV k="INCL" v={degStr(orbit.inclination)} />
        <KV k="PERIOD" v={minStr(orbit.period)} />
      </PaneBody>
    </GlassPane>
  );
}
