import { useEffect, useState } from 'react';
import { getReplayClient } from '../../../data/replay-client';
import type { HistoryRange, HistoryTimelinePoint } from '../../../data/replay-types';
import { useStore } from '../../../store/useStore';
import { BUTTON_RESET } from '../primitives/hud-styles';
import {
  bucketContains,
  bucketStartDay,
  bucketStarts,
  isoDay,
  jumpToDayMs,
  laneFraction,
  pickerBounds,
  REPLAY_RULE_DAYS,
  TIMELINE_ZOOMS,
  timelineWindow,
  yearJumpDay,
  type TimelineZoom,
} from './replay-nav';

const LABEL: React.CSSProperties = { fontSize: 8, letterSpacing: '0.12em', color: 'var(--hud-text-faint)' };

/** The four lanes of the events strip, top to bottom. Neutral tones only. */
const LANES = [
  { kind: 'object.appeared', label: 'NEW' },
  { kind: 'object.breakup', label: 'BRK' },
  { kind: 'elements.jump', label: 'ΔORB' },
  { kind: 'object.disappeared', label: 'LOST' },
] as const;
const LANE_KINDS = LANES.map((l) => l.kind);
const LANE_H = 9;
const LANE_GAP = 2;
const LABEL_W = 30;
const STRIP_W = 260;

/** Jump the review clock to `day`, keeping the time of day. */
function jumpTo(day: string) {
  const s = useStore.getState();
  s.reviewAt(new Date(jumpToDayMs(day, s.simTimeMs)));
}

/**
 * Replay navigation inside the open clock console: a date picker over the whole
 * archive (live range only without it), a year scrubber, the rule line, and the
 * events timeline strip. Reads replayRange; with no archive (503) only the picker
 * remains, bounded to the live range — no error state.
 */
export function ReplayNavigator() {
  const range = useStore((s) => s.replayRange);
  const simDay = useStore((s) => isoDay(s.simTimeMs));
  const wallDay = useStore((s) => isoDay(s.wallClockMs));
  const bounds = pickerBounds(range, Date.parse(`${wallDay}T12:00:00Z`));
  const minYear = Number(bounds.min.slice(0, 4));
  const maxYear = Number(bounds.max.slice(0, 4));
  const simYear = Number(simDay.slice(0, 4));

  return (
    <div style={{ marginTop: 8, paddingTop: 7, borderTop: '1px solid var(--hud-rule)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={LABEL}>{bounds.archive ? 'ARCHIVE' : 'LIVE RANGE'}</span>
        <input
          type="date"
          aria-label="Jump to date"
          value={simDay}
          min={bounds.min}
          max={bounds.max}
          onChange={(e) => {
            const d = e.target.value;
            if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d >= bounds.min && d <= bounds.max) jumpTo(d);
          }}
          style={{
            pointerEvents: 'auto',
            colorScheme: 'dark',
            background: 'transparent',
            color: 'var(--hud-text)',
            border: '1px solid var(--hud-glass-edge)',
            borderRadius: 3,
            font: 'inherit',
            fontSize: 10,
            padding: '1px 4px',
          }}
        />
      </div>
      {bounds.archive && maxYear > minYear && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
          <span style={{ ...LABEL, width: 26 }}>{minYear}</span>
          <input
            type="range"
            aria-label="Year"
            min={minYear}
            max={maxYear}
            step={1}
            value={Math.min(Math.max(simYear, minYear), maxYear)}
            onChange={(e) => jumpTo(yearJumpDay(Number(e.target.value), simDay, bounds.min, bounds.max))}
            style={{ pointerEvents: 'auto', flex: 1, height: 10, accentColor: 'oklch(0.82 0.01 240)' }}
          />
          <span style={{ ...LABEL, width: 26, textAlign: 'right' }}>{maxYear}</span>
        </div>
      )}
      <div style={{ ...LABEL, marginTop: 4, lineHeight: 1.4 }}>
        {bounds.archive
          ? `> ${REPLAY_RULE_DAYS} D BEFORE NOW → ARCHIVE CATALOG OF THAT DAY (${range!.firstDay} – ${range!.lastDay})`
          : 'ARCHIVE NOT AVAILABLE · LIVE ELEMENTS ONLY'}
      </div>
      {range && <EventsStrip range={range} simDay={simDay} />}
    </div>
  );
}

/** Compact events timeline: 4 lanes of small neutral bars, bucket by zoom; click a bucket to jump there. */
function EventsStrip({ range, simDay }: { range: HistoryRange; simDay: string }) {
  const [zoom, setZoom] = useState<TimelineZoom>('all');
  const win = timelineWindow(zoom, simDay, range);
  const [points, setPoints] = useState<HistoryTimelinePoint[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void getReplayClient()
      .timeline(win.from, win.to, win.bucket, LANE_KINDS)
      .then((p) => {
        if (!live) return;
        setPoints(p);
        setFailed(p === null);
      });
    return () => {
      live = false;
    };
  }, [win.from, win.to, win.bucket]);

  // Lay buckets out by time: the API omits empty ones.
  const byStart = new Map((points ?? []).map((p) => [bucketStartDay(p.t), p.counts] as const));
  const pts = bucketStarts(win.from, win.to, win.bucket).map((t) => ({ t, counts: byStart.get(t) ?? {} }));
  const maxBy = LANES.map((l) => pts.reduce((m, p) => Math.max(m, p.counts[l.kind] ?? 0), 0));
  const barsW = STRIP_W - LABEL_W;
  const colW = pts.length > 0 ? barsW / pts.length : barsW;
  const height = LANES.length * (LANE_H + LANE_GAP);

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={LABEL}>EVENTS · {win.bucket.toUpperCase()}</span>
        <span style={{ flex: 1 }} />
        {TIMELINE_ZOOMS.map((z) => (
          <button
            key={z}
            onClick={() => setZoom(z)}
            aria-pressed={zoom === z}
            style={{
              ...BUTTON_RESET,
              padding: '0 4px',
              fontSize: 8,
              letterSpacing: '0.1em',
              borderRadius: 2,
              color: zoom === z ? 'var(--hud-text)' : 'var(--hud-text-dim)',
              border: `1px solid ${zoom === z ? 'var(--hud-arc-dim)' : 'var(--hud-glass-edge)'}`,
            }}
          >
            {z.toUpperCase()}
          </button>
        ))}
      </div>
      {failed ? (
        <div style={{ ...LABEL, marginTop: 4 }}>EVENT COUNTS NOT AVAILABLE</div>
      ) : (
        <svg width={STRIP_W} height={height} style={{ display: 'block', marginTop: 4, pointerEvents: 'auto' }} role="img" aria-label="Events timeline">
          {LANES.map((l, li) => (
            <text key={l.kind} x={0} y={li * (LANE_H + LANE_GAP) + LANE_H - 1} fontSize={7} fill="var(--hud-text-faint)" fontFamily="var(--font-hud-mono)">
              {l.label}
            </text>
          ))}
          {pts.map((p, i) => {
            const x = LABEL_W + i * colW;
            const current = bucketContains(p.t, win.bucket, simDay);
            const start = bucketStartDay(p.t);
            const target = start < range.firstDay ? range.firstDay : start > range.lastDay ? range.lastDay : start;
            return (
              <g key={p.t} style={{ cursor: 'pointer' }} onClick={() => jumpTo(target)}>
                <title>{`${p.t}: ${LANES.map((l) => `${l.label} ${p.counts[l.kind] ?? 0}`).join(' · ')}`}</title>
                <rect x={x} y={0} width={Math.max(colW, 1)} height={height} fill={current ? 'oklch(0.94 0.01 240 / 0.10)' : 'transparent'} />
                {LANES.map((l, li) => {
                  const f = laneFraction(p.counts[l.kind] ?? 0, maxBy[li]);
                  if (f <= 0) return null;
                  const h = Math.max(1, f * LANE_H);
                  const y0 = li * (LANE_H + LANE_GAP) + (LANE_H - h);
                  return (
                    <rect
                      key={l.kind}
                      x={x + (colW > 3 ? 0.5 : 0)}
                      y={y0}
                      width={Math.max(colW - (colW > 3 ? 1 : 0), 0.6)}
                      height={h}
                      fill={`oklch(0.86 0.01 240 / ${0.35 + 0.15 * (3 - li)})`}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', ...LABEL, marginTop: 1 }}>
        <span>{win.from}</span>
        <span>{win.to}</span>
      </div>
    </div>
  );
}
