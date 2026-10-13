import { useMemo } from 'react';
import { waveBars } from './ask-bar';
import { BUTTON_RESET } from '../primitives/hud-styles';

/**
 * The ask bar's 48-bar pill. Static: fixed envelope heights, dim when idle,
 * cyan→amber while asking or compiling (colour is the only "alive" cue; nothing
 * moves). A button: clicking it opens (or, open, cancels) the bar.
 */
export function Waveform({ active, onClick }: { active: boolean; onClick: () => void }) {
  const bars = useMemo(() => waveBars(), []);
  return (
    <button
      onClick={onClick}
      aria-label="Ask the onboard AI"
      style={{
        ...BUTTON_RESET,
        display: 'flex',
        height: 32,
        width: 'min(560px, 60vw)',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        borderRadius: 9999,
        padding: '0 16px',
        background: 'var(--hud-glass)',
        border: '1px solid var(--hud-glass-edge)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      {bars.map((b, i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: 2,
            height: b.height,
            borderRadius: 2,
            background: active ? 'linear-gradient(180deg, oklch(0.9 0.14 210), oklch(0.85 0.14 55))' : 'var(--hud-arc-dim)',
          }}
        />
      ))}
    </button>
  );
}
