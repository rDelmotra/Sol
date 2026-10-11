const DISABLED = 'var(--hud-text-faint)';

/** One ACTIONS row: a full-width button, label left, key hint / state right. */
export function ActionRow({
  label,
  hint,
  active,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        margin: 0,
        font: 'inherit',
        pointerEvents: 'auto',
        textAlign: 'left',
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '5px 0',
        fontSize: 10,
        fontFamily: 'var(--font-hud-mono)',
        color: disabled ? DISABLED : active ? 'var(--hud-warn)' : 'var(--hud-text-dim)',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <span>{label}</span>
      <span style={{ color: disabled ? DISABLED : 'var(--hud-text)' }}>{hint}</span>
    </button>
  );
}
