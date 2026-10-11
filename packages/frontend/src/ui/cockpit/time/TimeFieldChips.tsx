import { useStore } from '../../../store/useStore';
import { TIME_FIELD_ORDER, type TimeField } from '../../../time/time-fields';
import { BUTTON_RESET } from '../primitives/hud-styles';
import { FIELD_LABEL } from './time-console';

const STEP_BTN: React.CSSProperties = {
  ...BUTTON_RESET,
  width: 15,
  height: 13,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 7,
  borderRadius: 2,
  color: 'var(--hud-text-dim)',
  border: '1px solid var(--hud-glass-edge)',
};

/** Six field chips (28 ms stagger) plus the ▲▼ step buttons. */
export function TimeFieldChips({ onStep }: { onStep: (f: TimeField, dir: number) => void }) {
  const field = useStore((s) => s.scrubField);
  const setField = useStore((s) => s.setScrubField);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 7 }}>
      {TIME_FIELD_ORDER.map((f, i) => (
        <button
          key={f}
          onClick={() => setField(f)}
          style={{
            ...BUTTON_RESET,
            padding: '1px 5px',
            borderRadius: 3,
            fontSize: 8,
            letterSpacing: '0.1em',
            color: field === f ? 'var(--hud-text)' : 'var(--hud-text-dim)',
            border: `1px solid ${field === f ? 'oklch(0.82 0.14 55 / 0.5)' : 'var(--hud-glass-edge)'}`,
            background: field === f ? 'oklch(0.82 0.14 55 / 0.14)' : 'transparent',
            animation: `hud-chip-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1) ${i * 28}ms both`,
            transition: 'color 160ms ease, background 160ms ease, border-color 160ms ease',
          }}
        >
          {FIELD_LABEL[f]}
        </button>
      ))}
      <span style={{ flex: 1 }} />
      <button onClick={() => onStep(field, 1)} aria-label="Increment" style={STEP_BTN}>▲</button>
      <button onClick={() => onStep(field, -1)} aria-label="Decrement" style={STEP_BTN}>▼</button>
    </div>
  );
}
