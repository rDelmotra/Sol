/** One dock segment: mono caps, 1 px underline when active, .35 when disabled. */
export function DockSeg({
  label,
  active,
  disabled,
  title,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      style={{
        appearance: 'none',
        background: 'none',
        border: 'none',
        borderBottom: `1px solid ${active ? 'var(--hud-arc)' : 'transparent'}`,
        padding: '3px 7px',
        fontFamily: 'var(--font-hud-mono)',
        fontSize: 9,
        letterSpacing: '0.16em',
        color: active ? 'var(--hud-text)' : 'var(--hud-text-dim)',
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}
