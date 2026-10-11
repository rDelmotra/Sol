import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { statusLabel } from '../format';
import { GlassPane } from '../primitives/GlassPane';
import { KV } from '../primitives/KV';
import { PaneBody } from '../primitives/PaneBody';
import { PaneHeader } from '../primitives/PaneHeader';
import type { PaneSlotProps } from '../primitives/PaneStack';

/** CATALOG card: status, launch date, epoch, radar cross-section size. */
export function CatalogPane({ selected, delay = 0, fromLeft = true }: { selected: EnrichedTLEObject } & PaneSlotProps) {
  return (
    <GlassPane fromLeft={fromLeft} delay={delay}>
      <PaneHeader label="CATALOG" value={selected.countryCode || '—'} />
      <PaneBody>
        <KV k="STATUS" v={statusLabel(selected.status ?? 'unknown')} />
        <KV k="LAUNCH" v={selected.launchDate ?? '—'} />
        <KV k="EPOCH" v={selected.epoch?.slice(0, 10) ?? '—'} />
        <KV k="RCS" v={selected.rcsSize ?? '—'} />
      </PaneBody>
    </GlassPane>
  );
}
