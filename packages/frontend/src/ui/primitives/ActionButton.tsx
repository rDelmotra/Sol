import type { CSSProperties, ReactNode } from 'react';

/**
 * Segmented action control for detail panels — the follow / joyride / orbit
 * cluster. `on` lights the telemetry (tracking) tone. Hover/focus/active visuals
 * live in `.ow-action-btn` (globals.css); `style` is layout only.
 */
export function ActionButton({
  on = false,
  onClick,
  title,
  style,
  children,
}: {
  on?: boolean;
  onClick?: () => void;
  title?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="ow-action-btn"
      data-on={on ? 'true' : 'false'}
      onClick={onClick}
      title={title}
      style={style}
    >
      {children}
    </button>
  );
}
