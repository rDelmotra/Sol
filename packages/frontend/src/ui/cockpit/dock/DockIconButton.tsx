import { DOCK_HELP_SIZE } from '../layout';

/** Small round outlined glyph button for the dock (the `?` that opens the controls sheet). */
export function DockIconButton({ glyph, label, onClick }: { glyph: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        appearance: 'none',
        background: 'none',
        border: '1px solid var(--hud-arc-dim)',
        borderRadius: 9999,
        width: DOCK_HELP_SIZE,
        height: DOCK_HELP_SIZE,
        padding: 0,
        color: 'var(--hud-text-dim)',
        fontFamily: 'var(--font-hud-mono)',
        fontSize: 11,
        lineHeight: 1,
        cursor: 'pointer',
      }}
    >
      {glyph}
    </button>
  );
}
