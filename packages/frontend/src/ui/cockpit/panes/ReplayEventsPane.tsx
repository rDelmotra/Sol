import { useEffect, useMemo, useState } from 'react';
import type { EnrichedTLEObject, SsaEvent } from '@orbitwatch/contracts';
import { fragmentIds } from '../../../data/replay-catalog';
import type { BreakupPayload } from '../../../data/replay-types';
import { useStore, type ReplayEventsStatus, type ReplayFragments } from '../../../store/useStore';
import { ActionRow } from '../primitives/ActionRow';
import { BUTTON_RESET } from '../primitives/hud-styles';
import { GlassPane } from '../primitives/GlassPane';
import { PaneBody } from '../primitives/PaneBody';
import { PaneHeader } from '../primitives/PaneHeader';
import type { PaneSlotProps } from '../primitives/PaneStack';
import { jumpToDayMs } from '../time/replay-nav';
import { countByKind, eventRows, toggleFragments, type CatalogEntry, type EventRowModel } from './replay-events';

const MONO = 'var(--font-hud-mono)';
const MAX_LIST_H = 248;

const FILTERS = [
  { key: 'all', label: 'ALL' },
  { key: 'object.appeared', label: 'NEW' },
  { key: 'object.breakup', label: 'BRK' },
  { key: 'elements.jump', label: 'ΔORB' },
  { key: 'object.disappeared', label: 'LOST' },
] as const;

/** Select + centre an object of the loaded catalog (existing engine commands via the store slots). */
function focusIndex(index: number) {
  const s = useStore.getState();
  if (s.triggerFlyTo) s.triggerFlyTo(index);
  else s.selectByIndex?.(index);
}

/** "Show fragments": filter to the launch's pieces (+ parent) and jump to the breakup's first day. */
function showFragments(b: BreakupPayload) {
  const s = useStore.getState();
  const next = toggleFragments(s.replayFragments, b);
  s.setReplayFragments(next);
  s.setAnalyticFilter(next ? fragmentIds(s.catalogData, next.launches, next.parentNorads) : null);
  if (next && next.launches.includes(b.launch) && b.firstDay && b.firstDay !== s.replayDay) {
    s.reviewAt(new Date(jumpToDayMs(b.firstDay, s.simTimeMs)));
  }
}

function clearFragments() {
  const s = useStore.getState();
  s.setReplayFragments(null);
  s.setAnalyticFilter(null);
}

function EventRow({ r, fragmentsOn }: { r: EventRowModel; fragmentsOn: boolean }) {
  const selectable = r.index !== null;
  return (
    <div
      style={{
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid transparent',
        fontFamily: MONO,
      }}
    >
      <button
        type="button"
        disabled={!selectable}
        onClick={selectable ? () => focusIndex(r.index!) : undefined}
        title={selectable ? 'Select and centre' : 'Not in this day’s catalog'}
        style={{ ...BUTTON_RESET, display: 'block', width: '100%', cursor: selectable ? 'pointer' : 'default' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 8, letterSpacing: '0.14em', color: 'var(--hud-text-faint)' }}>
          <span>{r.tag}</span>
          {selectable && <span>◎</span>}
        </div>
        <div style={{ fontSize: 11, color: selectable ? 'var(--hud-text)' : 'var(--hud-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.title}
        </div>
        {r.detail && <div style={{ fontSize: 10, color: 'var(--hud-text-dim)', marginTop: 1 }}>{r.detail}</div>}
      </button>
      {r.breakup && (
        <button
          type="button"
          onClick={() => showFragments(r.breakup!)}
          aria-pressed={fragmentsOn}
          style={{
            ...BUTTON_RESET,
            marginTop: 3,
            padding: '1px 6px',
            fontSize: 9,
            letterSpacing: '0.1em',
            borderRadius: 3,
            color: fragmentsOn ? 'var(--hud-text)' : 'var(--hud-text-dim)',
            border: `1px solid ${fragmentsOn ? 'var(--hud-arc-dim)' : 'var(--hud-glass-edge)'}`,
            background: fragmentsOn ? 'var(--hud-glow-tint)' : 'transparent',
          }}
        >
          {fragmentsOn ? 'FRAGMENTS SHOWN' : 'SHOW FRAGMENTS'}
        </button>
      )}
    </div>
  );
}

/**
 * EVENTS card (history replay): what changed in the catalog on the replayed day —
 * new objects (with launch), breakups (pieces, parent), orbit changes, objects no
 * longer tracked — from /api/ssa/events. A row selects and centres its object;
 * a breakup offers SHOW FRAGMENTS (filter to the launch's pieces, jump to the
 * first day). Plain wording, no severity.
 */
export function ReplayEventsPane({ delay = 0, fromLeft = false }: PaneSlotProps) {
  const day = useStore((s) => s.replayDay);
  const events = useStore((s) => (day ? s.replayEventsByDay[day] : undefined));
  const status = useStore((s) => (day ? s.replayEventsStatus[day] : undefined));
  const catalog = useStore((s) => s.catalogData);
  const fragments = useStore((s) => s.replayFragments);

  useEffect(() => {
    if (day) void useStore.getState().loadReplayEvents(day);
  }, [day]);

  return <ReplayEventsView day={day} events={events} status={status} catalog={catalog} fragments={fragments} delay={delay} fromLeft={fromLeft} />;
}

export interface ReplayEventsViewProps extends PaneSlotProps {
  day: string | null;
  events: SsaEvent[] | undefined;
  status: ReplayEventsStatus | undefined;
  catalog: EnrichedTLEObject[];
  fragments: ReplayFragments | null;
}

/** The EVENTS card body (store-free, so it renders in tests). */
export function ReplayEventsView({ day, events, status, catalog, fragments, delay = 0, fromLeft = false }: ReplayEventsViewProps) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');

  const lookup = useMemo(() => {
    const m = new Map<number, CatalogEntry>();
    catalog.forEach((o, index) =>
      m.set(o.noradId, { index, name: o.name, designator: (o.omm?.OBJECT_ID as string | undefined) || null, launchDate: o.launchDate }),
    );
    return (n: number) => m.get(n);
  }, [catalog]);
  const rows = useMemo(() => (events ? eventRows(events, lookup) : []), [events, lookup]);
  const counts = countByKind(rows);
  const shown = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);

  let body;
  if (!day) body = <Note text="Replay a past date to list its catalog events" />;
  else if (status === 'unavailable') body = <Note text="Event data unavailable for this day" />;
  else if (!status || status === 'loading') body = <Note text="Loading events…" />;
  else if (rows.length === 0) body = <Note text="No catalog changes recorded for this day" />;
  else
    body = (
      <>
        <div style={{ display: 'flex', gap: 3, padding: '0 4px 4px', flexWrap: 'wrap' }}>
          {FILTERS.map((f) => {
            const n = f.key === 'all' ? rows.length : counts[f.key] ?? 0;
            const on = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={on}
                disabled={n === 0 && f.key !== 'all'}
                style={{
                  ...BUTTON_RESET,
                  padding: '0 5px',
                  fontSize: 8,
                  letterSpacing: '0.1em',
                  fontFamily: MONO,
                  borderRadius: 2,
                  color: n === 0 ? 'var(--hud-text-faint)' : on ? 'var(--hud-text)' : 'var(--hud-text-dim)',
                  border: `1px solid ${on ? 'var(--hud-arc-dim)' : 'var(--hud-glass-edge)'}`,
                }}
              >
                {f.label} {n}
              </button>
            );
          })}
        </div>
        <div style={{ maxHeight: MAX_LIST_H, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {shown.map((r) => (
            <EventRow key={r.id} r={r} fragmentsOn={!!(r.breakup && fragments?.launches.includes(r.breakup.launch))} />
          ))}
        </div>
      </>
    );

  return (
    <GlassPane fromLeft={fromLeft} delay={delay}>
      <PaneHeader label="EVENTS" value={day ? `${day} UTC` : undefined} />
      <PaneBody padding="6px 6px 6px">
        {body}
        {fragments && (
          <ActionRow label={`FRAGMENTS · ${fragments.launches.join(', ')}`} hint="CLEAR ×" onClick={clearFragments} />
        )}
      </PaneBody>
    </GlassPane>
  );
}

function Note({ text }: { text: string }) {
  return <div style={{ padding: '10px 8px', fontSize: 10, lineHeight: 1.5, color: 'var(--hud-text-dim)', fontFamily: MONO }}>{text}</div>;
}
