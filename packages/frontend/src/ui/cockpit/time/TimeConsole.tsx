import { useState } from 'react';
import { useStore } from '../../../store/useStore';
import { LIVE_EPSILON_MS, type TimeField } from '../../../time/time-fields';
import { BUTTON_RESET } from '../primitives/hud-styles';
import { groupInt } from '../format';
import { HUD_CORNER_INSET, TIME_CONSOLE_OPEN_W } from '../layout';
import { ReturnToPresentButton } from './ReturnToPresentButton';
import { TimeDigit } from './TimeDigit';
import { TimeFieldChips } from './TimeFieldChips';
import { TimeWheel } from './TimeWheel';
import { formatTimeDelta, utcFieldValues } from './time-console';
import { useTimeStep } from './useTimeStep';

function ClockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

const SEP = (c: string) => <span style={{ opacity: 0.4 }}>{c}</span>;

/**
 * Top-left clock row that unfolds in place into the scrubber. Two states, told
 * by colour: LIVE (neutral) and REVIEW (amber, displaced > LIVE_EPSILON_MS from
 * the wall clock; a signed "FROM NOW" line and the ↺ appear, ↺ even when closed).
 * Reads the same scrubberMode / scrubField the gamepad drives.
 */
export function TimeConsole() {
  const open = useStore((s) => s.scrubberMode);
  const field = useStore((s) => s.scrubField);
  const focusOnReset = useStore((s) => s.scrubFocusOnReset);
  const simTimeMs = useStore((s) => s.simTimeMs);
  const wallClockMs = useStore((s) => s.wallClockMs);
  const viewMode = useStore((s) => s.viewMode);
  const simRate = useStore((s) => s.simRate);
  const objectCount = useStore((s) => s.objectCount);
  const gamepadConnected = useStore((s) => s.gamepadConnected);
  const [hover, setHover] = useState(false);
  const step = useTimeStep();

  const displaced = Math.abs(simTimeMs - wallClockMs) > LIVE_EPSILON_MS;
  const values = utcFieldValues(simTimeMs);
  const accent = displaced ? 'var(--hud-warn)' : 'var(--hud-text)';
  const label = open ? 'SCRUB' : displaced ? 'REVIEW' : 'MET';
  const select = (f: TimeField) => useStore.getState().setScrubField(f);
  // Focus parked on ↺ means exactly one "the D-pad is here" marker at a time.
  const digit = (f: TimeField) => (
    <TimeDigit key={f} field={f} value={values[f]} open={open} active={open && field === f && !focusOnReset} onSelect={select} onStep={step} />
  );

  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        left: HUD_CORNER_INSET,
        top: HUD_CORNER_INSET,
        fontSize: 10,
        lineHeight: 1.625,
        fontFamily: 'var(--font-hud-mono)',
        color: 'var(--hud-text-dim)',
        width: open ? TIME_CONSOLE_OPEN_W : undefined,
      }}
    >
      {open && (
        <div
          style={{
            position: 'absolute', inset: '-8px -10px -8px -10px',
            background: 'var(--hud-glass)',
            border: '1px solid var(--hud-glass-edge)',
            borderRadius: 8,
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            transformOrigin: 'top center',
            animation: 'hud-console-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        >
          <span
            style={{
              position: 'absolute', left: -1, top: 6, bottom: 6, width: 2,
              background: 'var(--hud-warn)', borderRadius: 2,
              transformOrigin: 'top', animation: 'hud-rail-in 260ms cubic-bezier(0.2, 0.8, 0.2, 1)',
            }}
          />
        </div>
      )}

      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={() => useStore.getState().setScrubberMode(!open)}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
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

        {!open && (
          <span
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0, height: 1,
              background: 'var(--hud-arc-dim)',
              transform: `scaleX(${hover ? 1 : 0})`,
              transformOrigin: 'left',
              transition: 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
            }}
          />
        )}

        {open && <TimeFieldChips onStep={step} />}
        {open && <TimeWheel />}

        {displaced && (
          <div style={{ marginTop: open ? 6 : 0, color: 'var(--hud-warn)', opacity: 0.9 }}>
            {formatTimeDelta(simTimeMs, wallClockMs)} FROM NOW
          </div>
        )}

        <div style={{ marginTop: open ? 6 : 0 }}>MODE {viewMode.toUpperCase()} · {simRate}×</div>
        <div>TRACKING {groupInt(objectCount)} OBJ</div>

        {open && (
          <div style={{ marginTop: 6, fontSize: 8, letterSpacing: '0.08em', opacity: 0.5 }}>
            {gamepadConnected ? '▲▼ VALUE · ◄► FIELD · SCROLL OVER DIGITS' : 'SCROLL OVER DIGITS · CLICK A FIELD'}
          </div>
        )}
      </div>
    </div>
  );
}
