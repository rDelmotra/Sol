import { useMemo } from 'react';
import { useStore } from '../../../store/useStore';
import { EmptyPane } from '../primitives/EmptyPane';
import { degStr, elementOrbit, kmStr, minStr } from '../format';
import { GlassPane } from '../primitives/GlassPane';
import { IdentityPane } from './IdentityPane';
import { KV } from '../primitives/KV';
import { LEFT_PANE_W, PANE_EDGE_INSET, PANE_GAP, PANE_STAGGER_MS } from '../layout';
import { PaneHeader } from '../primitives/PaneHeader';

/** Left stack (Q): IDENTITY, ORBIT, CATALOG of the lock, vertically centred. */
export function AnalysisPanes() {
  const open = useStore((s) => s.analysisPanelOpen);
  const selected = useStore((s) => s.selectedSatellite);
  const orbit = useMemo(() => (selected ? elementOrbit(selected) : null), [selected]);
  if (!open) return null;

  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        left: PANE_EDGE_INSET,
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: PANE_GAP,
        width: LEFT_PANE_W,
      }}
    >
      {!selected ? (
        <EmptyPane text="NO OBJECT LOCKED" />
      ) : (
        <>
          <IdentityPane selected={selected} delay={0} />

          <GlassPane delay={PANE_STAGGER_MS}>
            <PaneHeader label="ORBIT" value={selected.regime} />
            <div style={{ padding: '12px' }}>
              <KV k="APOGEE" v={kmStr(orbit?.apogee)} />
              <KV k="PERIGEE" v={kmStr(orbit?.perigee)} />
              <KV k="INCL" v={degStr(orbit?.inclination)} />
              <KV k="PERIOD" v={minStr(orbit?.period)} />
            </div>
          </GlassPane>

          <GlassPane delay={2 * PANE_STAGGER_MS}>
            <PaneHeader label="CATALOG" value={selected.countryCode || '—'} />
            <div style={{ padding: '12px' }}>
              <KV k="STATUS" v={(selected.status ?? 'unknown').replace(/_/g, ' ').toUpperCase()} />
              <KV k="LAUNCH" v={selected.launchDate ?? '—'} />
              <KV k="EPOCH" v={selected.epoch?.slice(0, 10) ?? '—'} />
              <KV k="RCS" v={selected.rcsSize ?? '—'} />
            </div>
          </GlassPane>
        </>
      )}
    </div>
  );
}
