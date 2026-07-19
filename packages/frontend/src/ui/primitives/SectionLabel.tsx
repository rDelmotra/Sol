import type { CSSProperties, ReactNode } from 'react';

/**
 * A quiet uppercase group heading for detail panels (Identity / Orbit / …).
 * Structures a readout into instrument-like sections without shouting.
 */
export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...labelStyle, ...style }}>{children}</div>;
}

const labelStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-display)',
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--ow-text-faint)',
  marginBottom: 6,
};
