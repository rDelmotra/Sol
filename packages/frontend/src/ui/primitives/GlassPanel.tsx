import type { CSSProperties, ReactNode } from 'react';

/**
 * The one canonical frosted surface. `elev` picks the translucency/blur tier
 * (1 ambient → 3 popover). Everything visual comes from the `.ow-glass` class in
 * globals.css; `style` is for layout only (position, size, padding, gap).
 */
export function GlassPanel({
  elev = 2,
  className = '',
  style,
  children,
  ...rest
}: {
  elev?: 1 | 2 | 3;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`ow-glass ${className}`.trim()} data-elev={elev} style={style} {...rest}>
      {children}
    </div>
  );
}
