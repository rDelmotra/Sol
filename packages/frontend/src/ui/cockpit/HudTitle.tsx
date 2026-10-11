import { TITLE_TOP } from './layout';

/** Centred "ORBITAL / SSA-01" placard. */
export function HudTitle() {
  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        left: '50%',
        top: TITLE_TOP,
        transform: 'translateX(-50%)',
        fontSize: 10,
        letterSpacing: '0.5em',
        color: 'var(--hud-text-dim)',
        fontFamily: 'var(--font-hud-mono)',
      }}
    >
      ORBITAL / SSA-01
    </div>
  );
}
