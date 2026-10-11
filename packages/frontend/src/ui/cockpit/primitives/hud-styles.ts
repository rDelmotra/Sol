/** Native-button reset shared by the cockpit's clickable text (time console, ask bar). */
export const BUTTON_RESET: React.CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  margin: 0,
  padding: 0,
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  pointerEvents: 'auto',
  textAlign: 'left',
};

/** Mono 9px header over a group of rows (controls sheet columns). */
export const SECTION_LABEL: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.18em',
  fontFamily: 'var(--font-hud-mono)',
  color: 'var(--hud-arc-dim)',
  fontWeight: 600,
};
