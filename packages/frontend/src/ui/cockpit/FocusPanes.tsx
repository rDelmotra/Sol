import { useMemo } from 'react';
import { useStore } from '../../store/useStore';
import { ActionsPane } from './ActionsPane';
import { EmptyPane } from './EmptyPane';
import { ageString, kindCode } from './format';
import { GlassPane } from './GlassPane';
import { KV } from './KV';
import { ORBIT_DIAGRAM_H, PANE_EDGE_INSET, PANE_GAP, PANE_STAGGER_MS, RIGHT_PANE_W } from './layout';
import { OrbitDiagram } from './OrbitDiagram';
import { PaneHeader } from './PaneHeader';
import { TelemetryPane } from './TelemetryPane';

/**
 * Right stack (E): OBJECT SCAN (orbit diagram + scan sweep), TELEMETRY,
 * ACTIONS. The diagram's slot is ORBIT_DIAGRAM_H (128 px) tall.
 */
export function FocusPanes() {
  const open = useStore((s) => s.focusPanelOpen);
  const selected = useStore((s) => s.selectedSatellite);
  // Wall-clock age, fixed per lock: months do not need a clock subscription.
  const age = useMemo(() => (selected ? ageString(selected.launchDate, Date.now()) : null), [selected]);
  if (!open) return null;

  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        right: PANE_EDGE_INSET,
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: PANE_GAP,
        width: RIGHT_PANE_W,
      }}
    >
      {!selected ? (
        <EmptyPane text="NO OBJECT LOCKED" fromLeft={false} />
      ) : (
        <>
          <GlassPane fromLeft={false} delay={0}>
            <PaneHeader label="OBJECT SCAN" value={`NORAD ${selected.noradId}`} />
            <div style={{ padding: '12px' }}>
              <div style={{ position: 'relative', margin: '0 auto', height: ORBIT_DIAGRAM_H, width: '100%' }}>
                <OrbitDiagram object={selected} />
                <div
                  className="hud-loop"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background:
                      'linear-gradient(180deg, transparent 40%, oklch(0.85 0.14 220 / 0.06) 50%, transparent 60%)',
                    animation: 'hud-scan 3.4s linear infinite',
                  }}
                />
              </div>
              <div style={{ marginTop: 8 }}>
                <KV k="TYPE" v={kindCode(selected.objectType)} />
                <KV k="RCS" v={selected.rcsSize ?? '—'} />
                <KV k="AGE" v={age ?? '—'} />
              </div>
            </div>
          </GlassPane>

          <TelemetryPane selected={selected} delay={PANE_STAGGER_MS} />
          <ActionsPane delay={2 * PANE_STAGGER_MS} />
        </>
      )}
    </div>
  );
}
