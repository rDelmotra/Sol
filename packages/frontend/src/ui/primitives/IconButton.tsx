import type { CSSProperties, ReactNode } from 'react';

/** Square, quiet icon button. Hover/focus live in `.ow-icon-btn`. */
export function IconButton({
  onClick,
  title,
  ariaLabel,
  active = false,
  className = '',
  style,
  children,
}: {
  onClick?: () => void;
  title?: string;
  ariaLabel?: string;
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`ow-icon-btn ${className}`.trim()}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      style={{
        ...(active
          ? {
              color: 'var(--ow-telemetry)',
              borderColor: 'var(--ow-telemetry-line)',
              background: 'var(--ow-telemetry-soft)',
            }
          : null),
        ...style,
      }}
    >
      {children}
    </button>
  );
}
