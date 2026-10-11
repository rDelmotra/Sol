/** Card title row: spaced mono label left, optional value right, hairline under. */
export function PaneHeader({ label, value }: { label: string; value?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--hud-glass-edge)',
        padding: '8px 12px',
      }}
    >
      <span style={{ fontSize: 9, letterSpacing: '0.4em', color: 'var(--hud-text-dim)', fontFamily: 'var(--font-hud-mono)' }}>
        {label}
      </span>
      {value && <span style={{ fontSize: 10, color: 'var(--hud-text)', fontFamily: 'var(--font-hud-mono)' }}>{value}</span>}
    </div>
  );
}
