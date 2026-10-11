import type { ReactNode } from 'react';

/**
 * The HUD glass card. Fans in from its side (hud-pane-in 380 ms, from ∓16 px);
 * `delay` staggers a stack. Closing is instant (the stack unmounts).
 */
export function GlassPane({ children, fromLeft = true, delay = 0 }: { children: ReactNode; fromLeft?: boolean; delay?: number }) {
  return (
    <div
      style={
        {
          position: 'relative',
          borderRadius: 8,
          pointerEvents: 'auto',
          background: 'var(--hud-glass)',
          border: '1px solid var(--hud-glass-edge)',
          backdropFilter: 'blur(14px) saturate(120%)',
          WebkitBackdropFilter: 'blur(14px) saturate(120%)',
          boxShadow: 'var(--hud-inner-glow), var(--hud-drop-shadow)',
          animation: `hud-pane-in 380ms ${delay}ms cubic-bezier(.2,.7,.2,1) both`,
          '--hud-pane-from': fromLeft ? '-16px' : '16px',
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
