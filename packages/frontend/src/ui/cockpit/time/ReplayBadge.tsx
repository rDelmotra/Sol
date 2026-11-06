import { useStore } from '../../../store/useStore';
import { accuracyBadge } from './replay-nav';

/**
 * History replay badge under the clock console: which archive day the satellites
 * come from, the era's typical position error (median, from the catalog response)
 * and a note when some objects run on the original SGP model. Nothing in live mode.
 */
export function ReplayBadge() {
  const replayDay = useStore((s) => s.replayDay);
  const accuracy = useStore((s) => s.replayAccuracy);
  const sgpCount = useStore((s) => s.replaySgpCount);
  const badge = accuracyBadge(replayDay, accuracy, sgpCount);
  if (!badge) return null;
  return (
    <div
      role="status"
      aria-label="Replay accuracy"
      style={{
        marginTop: 6,
        padding: '3px 7px',
        border: '1px solid var(--hud-glass-edge)',
        borderRadius: 4,
        background: 'var(--hud-glass)',
        fontSize: 9,
        lineHeight: 1.5,
        letterSpacing: '0.04em',
        color: 'var(--hud-text-dim)',
        width: 'fit-content',
        maxWidth: 260,
      }}
    >
      <div style={{ color: 'var(--hud-text)', letterSpacing: '0.12em', fontSize: 8 }}>{badge.title}</div>
      <div>{badge.accuracy}</div>
      {badge.note && <div style={{ color: 'var(--hud-text-faint)' }}>{badge.note}</div>}
    </div>
  );
}
