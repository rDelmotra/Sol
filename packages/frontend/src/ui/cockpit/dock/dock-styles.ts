/** Shared dock styles (ModeControls, LensLocationControls, LocationPopover). */
export const DOCK_BLUE = 'oklch(0.82 0.08 230 / 0.7)';

export const DOCK_LABEL: React.CSSProperties = {
  fontSize: 8,
  letterSpacing: '0.3em',
  color: 'var(--hud-text-dim)',
  marginRight: 10,
};

export const DOCK_GROUP: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: '100%',
  fontFamily: 'var(--font-hud-mono)',
};
