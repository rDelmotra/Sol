import { useEffect } from 'react';
import type { EncounterSummary, EnrichedTLEObject } from '@orbitwatch/contracts';
import { useStore } from '../../../store/useStore';
import { formatCountdown, formatMiss, formatObjectLabel, formatPc, formatRelSpeed } from '../../../data/encounter-format';
import { ActionRow } from '../primitives/ActionRow';
import { GlassPane } from '../primitives/GlassPane';
import { PaneBody } from '../primitives/PaneBody';
import { PaneHeader } from '../primitives/PaneHeader';
import type { PaneSlotProps } from '../primitives/PaneStack';
import { ManoeuvreTag } from './ManoeuvreTag';

const MONO = 'var(--font-hud-mono)';
const MAX_LIST_H = 232;

/** The other object of an encounter, seen from `noradId`. */
export function otherObject(e: EncounterSummary, noradId: number) {
  return e.a.noradId === noradId ? e.b : e.a;
}

/** Live countdown. Its own leaf: it re-renders with the sim clock, the list does not. */
function Countdown({ tca }: { tca: string }) {
  const simTimeMs = useStore((s) => s.simTimeMs);
  return <span>{formatCountdown(Date.parse(tca), simTimeMs)}</span>;
}

/** Live clock leaf, like Countdown: the "ago" follows the sim clock without re-rendering the list. */
function LiveManoeuvreTag({ e, noradId }: { e: EncounterSummary; noradId: number }) {
  const simTimeMs = useStore((s) => s.simTimeMs);
  return <ManoeuvreTag e={e} noradId={noradId} nowMs={simTimeMs} />;
}

function EncounterRow({ e, noradId, selected }: { e: EncounterSummary; noradId: number; selected: boolean }) {
  const other = otherObject(e, noradId);
  const show = () => {
    const s = useStore.getState();
    if (s.triggerShowEncounter) s.triggerShowEncounter(e.id);
    else s.selectEncounter(e.id);
  };
  return (
    <button
      type="button"
      onClick={show}
      aria-pressed={selected}
      style={{
        appearance: 'none',
        display: 'block',
        width: '100%',
        margin: 0,
        padding: '6px 8px',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        pointerEvents: 'auto',
        color: 'var(--hud-text)',
        background: selected ? 'var(--hud-glow-tint)' : 'transparent',
        border: `1px solid ${selected ? 'var(--hud-arc-glow)' : 'transparent'}`,
        borderRadius: 6,
        fontFamily: MONO,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatObjectLabel(other)}</span>
        <span style={{ whiteSpace: 'nowrap' }}>
          <Countdown tca={e.tca} />
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 2, fontSize: 10, color: 'var(--hud-text-dim)' }}>
        <span>
          {formatMiss(e.missKm)} · {formatRelSpeed(e.relSpeedKms)}
        </span>
        <span>
          Pc {formatPc(e.pc)}
          {e.manoeuvrable && <span style={{ marginLeft: 6, color: 'var(--hud-text-faint)' }}>manoeuvrable</span>}
        </span>
      </div>
      <LiveManoeuvreTag e={e} noradId={noradId} />
    </button>
  );
}

/**
 * ENCOUNTERS card: the focused object's close approaches (flybys) in the next
 * 36 h, soonest first. Each row shows the other object, the countdown to closest
 * approach, miss distance, relative speed and Pc as plain numbers, all from the
 * server. Clicking a row watches the flyby (engine command via the store slot).
 */
export function EncountersPane({ selected, delay = 0, fromLeft = false }: { selected: EnrichedTLEObject } & PaneSlotProps) {
  const noradId = selected.noradId;
  const status = useStore((s) => s.encounterStatusByNorad[noradId]);
  const list = useStore((s) => s.encountersByNorad[noradId]);
  const selectedId = useStore((s) => s.selectedEncounterId);

  useEffect(() => {
    void useStore.getState().loadEncounters(noradId);
  }, [noradId]);

  const clear = () => {
    const s = useStore.getState();
    if (s.triggerClearEncounter) s.triggerClearEncounter();
    else s.selectEncounter(null);
  };

  const rows = list ?? [];
  let body;
  if (status === 'unavailable' || status === 'error') {
    body = <Note text="Encounter data unavailable" />;
  } else if (!status || status === 'loading') {
    body = <Note text="Loading encounters…" />;
  } else if (rows.length === 0) {
    body = <Note text="No encounters within 5 km in the next 36 h" />;
  } else {
    body = (
      <div style={{ maxHeight: MAX_LIST_H, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((e) => (
          <EncounterRow key={e.id} e={e} noradId={noradId} selected={e.id === selectedId} />
        ))}
      </div>
    );
  }

  return (
    <GlassPane fromLeft={fromLeft} delay={delay}>
      <PaneHeader label="ENCOUNTERS" value={status === 'ready' && rows.length > 0 ? `${rows.length} · 36 H` : '36 H'} />
      <PaneBody padding="6px 6px 6px">
        {body}
        {selectedId !== null && <ActionRow label="END FLYBY" hint="×" onClick={clear} />}
      </PaneBody>
    </GlassPane>
  );
}

function Note({ text }: { text: string }) {
  return (
    <div style={{ padding: '10px 8px', fontSize: 10, lineHeight: 1.5, color: 'var(--hud-text-dim)', fontFamily: MONO }}>{text}</div>
  );
}
