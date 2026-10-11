import { useState } from 'react';
import { useStore } from '../../../store/useStore';
import { HUD_CORNER_INSET, TIME_CONSOLE_OPEN_W } from '../layout';
import { ClockRow } from './ClockRow';
import { DeltaLine, ScrubHint, StatusLines } from './ConsoleReadouts';
import { TimeFieldChips } from './TimeFieldChips';
import { TimeWheel } from './TimeWheel';
import { useTimeStep } from './useTimeStep';

/**
 * Top-left clock row that unfolds in place into the scrubber. Two states, told
 * by colour: LIVE (neutral) and REVIEW (amber, displaced > LIVE_EPSILON_MS from
 * the wall clock; a signed "FROM NOW" line and the ↺ appear, ↺ even when closed).
 * Reads the same scrubberMode / scrubField the gamepad drives.
 */
export function TimeConsole() {
  const open = useStore((s) => s.scrubberMode);
  const [hover, setHover] = useState(false);
  const step = useTimeStep();

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
        <ClockRow open={open} hover={hover} onHover={setHover} onStep={step} />

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

        <DeltaLine open={open} />
        <StatusLines open={open} />
        {open && <ScrubHint />}
      </div>
    </div>
  );
}
