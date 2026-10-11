/** One key / value row inside a card. */
export function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '4px 0' }}>
      <span style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--hud-text-dim)', fontFamily: 'var(--font-hud-mono)' }}>{k}</span>
      <span style={{ fontSize: 11, color: 'var(--hud-text)', fontFamily: 'var(--font-hud-mono)' }}>{v}</span>
    </div>
  );
}
