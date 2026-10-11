import { useStore } from '../../../store/useStore';
import { LIVE_EPSILON_MS, type TimeField } from '../../../time/time-fields';
import { BUTTON_RESET } from '../primitives/hud-styles';
import { ReturnToPresentButton } from './ReturnToPresentButton';
import { TimeDigit } from './TimeDigit';
import { utcFieldValues } from './time-console';

function ClockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

const SEP = (c: string) => <span style={{ opacity: 0.4 }}>{c}</span>;

/** True when the sim clock sits more than LIVE_EPSILON_MS from the wall clock. Boolean, so a subscriber re-renders only when it flips. */
const selectDisplaced = (s: { simTimeMs: number; wallClockMs: number }) => Math.abs(s.simTimeMs - s.wallClockMs) > LIVE_EPSILON_MS;

interface ClockRowProps {
  open: boolean;
  onStep: (field: TimeField, dir: number) => void;
  onHover: (hover: boolean) => void;
  hover: boolean;
}

/** The clock button (glyph, label, UTC digits) and, when displaced, the ↺ button. */
export function ClockRow({ open, onStep, onHover, hover }: ClockRowProps) {
  const field = useStore((s) => s.scrubField);
  const focusOnReset = useStore((s) => s.scrubFocusOnReset);
  const simTimeMs = useStore((s) => s.simTimeMs);
  const displaced = useStore(selectDisplaced);

  const values = utcFieldValues(simTimeMs);
  const accent = displaced ? 'var(--hud-warn)' : 'var(--hud-text)';
  const label = open ? 'SCRUB' : displaced ? 'REVIEW' : 'MET';
  const select = (f: TimeField) => useStore.getState().setScrubField(f);
  // Focus parked on ↺ means exactly one "the D-pad is here" marker at a time.
  const digit = (f: TimeField) => (
    <TimeDigit key={f} field={f} value={values[f]} open={open} active={open && field === f && !focusOnReset} onSelect={select} onStep={onStep} />
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={() => useStore.getState().setScrubberMode(!open)}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        aria-label={open ? 'Close time scrubber' : 'Open time scrubber'}
        style={{
          ...BUTTON_RESET,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: accent,
          fontSize: open ? 12 : 10,
          letterSpacing: '0.02em',
          fontVariantNumeric: 'tabular-nums',
          transition: 'font-size 180ms cubic-bezier(0.2, 0.8, 0.2, 1), color 200ms ease',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            opacity: open || hover || displaced ? 1 : 0.35,
            transition: 'opacity 200ms ease',
          }}
        >
          <ClockGlyph />
        </span>
        <span style={{ fontSize: 9, letterSpacing: '0.14em', opacity: 0.75 }}>{label}</span>
        {/* While open the digits are a work surface: swallow clicks so a near-miss on a separator cannot fold the console mid-edit. */}
        <span
          onClick={open ? (e) => e.stopPropagation() : undefined}
          style={{ display: 'inline-flex', alignItems: 'baseline', gap: 1, cursor: open ? 'default' : 'inherit' }}
        >
          {digit('year')}{SEP('-')}{digit('month')}{SEP('-')}{digit('day')}
          <span style={{ width: 6 }} />
          {digit('hour')}{SEP(':')}{digit('minute')}{SEP(':')}{digit('second')}
          <span style={{ marginLeft: 5, fontSize: 9, opacity: 0.5 }}>UTC</span>
        </span>
      </button>
      {displaced && <ReturnToPresentButton />}
    </div>
  );
}
