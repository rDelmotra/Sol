import type { CSSProperties, ReactNode } from 'react';

/**
 * Segmented / toggle / filter chip. `on` drives the active accent tone;
 * `accent` picks which semantic colour that active state uses (perceptor =
 * violet default, telemetry = cyan). Hover/focus live in `.ow-pill`.
 */
export function Pill({
  on = false,
  accent = 'perceptor',
  onClick,
  title,
  className = '',
  style,
  children,
}: {
  on?: boolean;
  accent?: 'perceptor' | 'telemetry';
  onClick?: () => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`ow-pill ${className}`.trim()}
      data-on={on ? 'true' : 'false'}
      data-accent={accent}
      onClick={onClick}
      title={title}
      style={style}
    >
      {children}
    </button>
  );
}
