import type { CSSProperties } from 'react';

export type FilterItemState = 'implicit' | 'selected' | 'excluded';

/**
 * A filter chip that doubles as a data bar: the fill width encodes how much of
 * the category is currently visible (`visible / total`), so the Lens sheet reads
 * as a live histogram you can toggle. `state` sets the emphasis; `color` tints a
 * selected chip to its category swatch.
 *
 * Promoted from the parked ui/Lens/VisualDataTag and moved onto design tokens.
 */
export function DataTag({
  label,
  state,
  visible,
  total,
  color,
  onClick,
}: {
  label: string;
  state: FilterItemState;
  visible: number;
  total: number;
  color?: string;
  onClick: () => void;
}) {
  const percent = total > 0 ? (visible / total) * 100 : 0;

  const tone =
    state === 'selected'
      ? {
          border: color
            ? `color-mix(in srgb, ${color} 70%, transparent)`
            : 'var(--ow-perceptor-line)',
          background: color
            ? `color-mix(in srgb, ${color} 20%, transparent)`
            : 'var(--ow-perceptor-soft)',
          fill: color
            ? `color-mix(in srgb, ${color} 34%, transparent)`
            : 'var(--ow-perceptor-soft)',
          text: 'var(--ow-text-hi)',
          weight: 500,
        }
      : state === 'implicit'
      ? {
          border: 'var(--ow-stroke-strong)',
          background: 'var(--ow-surface-hover)',
          fill: 'rgba(150, 170, 220, 0.10)',
          text: 'var(--ow-text-mid)',
          weight: 400,
        }
      : {
          border: 'var(--ow-stroke)',
          background: 'transparent',
          fill: 'rgba(150, 170, 220, 0.05)',
          text: 'var(--ow-text-faint)',
          weight: 400,
        };

  const pillStyle: CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 11px',
    borderRadius: 'var(--ow-r-pill)',
    border: `1px solid ${tone.border}`,
    background: tone.background,
    color: tone.text,
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: 'var(--ow-font-display)',
    transition: 'border-color var(--ow-dur-1) var(--ow-ease), color var(--ow-dur-1) var(--ow-ease)',
    overflow: 'hidden',
  };

  const fillStyle: CSSProperties = {
    position: 'absolute',
    inset: '0 auto 0 0',
    width: `${percent}%`,
    background: tone.fill,
    zIndex: 0,
    transition: 'width var(--ow-dur-3) var(--ow-ease)',
  };

  return (
    <button onClick={onClick} style={pillStyle}>
      <div style={fillStyle} />
      <span style={{ position: 'relative', zIndex: 1, fontWeight: tone.weight }}>{label}</span>
      <span
        style={{
          position: 'relative',
          zIndex: 1,
          opacity: state === 'selected' ? 0.9 : 0.55,
          fontSize: 10,
          fontFamily: 'var(--ow-font-mono)',
        }}
      >
        {visible.toLocaleString()}
      </span>
    </button>
  );
}
