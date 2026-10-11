import { GlassPane } from './GlassPane';

/** A single card with a centred message, for a stack with nothing to show. */
export function EmptyPane({ text, fromLeft = true }: { text: string; fromLeft?: boolean }) {
  return (
    <GlassPane fromLeft={fromLeft}>
      <div
        style={{
          padding: '18px 14px',
          fontSize: 10,
          letterSpacing: '0.15em',
          color: 'var(--hud-text-dim)',
          fontFamily: 'var(--font-hud-mono)',
          textAlign: 'center',
        }}
      >
        {text}
      </div>
    </GlassPane>
  );
}
