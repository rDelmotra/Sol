import type { ReactNode } from 'react';

/** The padded body of a GlassPane card. */
export function PaneBody({ children, padding = '12px' }: { children: ReactNode; padding?: string }) {
  return <div style={{ padding }}>{children}</div>;
}
