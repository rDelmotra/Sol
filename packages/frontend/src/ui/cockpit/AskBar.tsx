import { useStore } from '../../store/useStore';
import { useAnalyticAsk } from '../useAnalyticAsk';
import { askCaption } from './ask-bar';
import { DOCK_GAP, DOCK_H } from './layout';
import { Waveform } from './Waveform';

/**
 * Bottom-centre ask bar. Closed: a caption (hint / COMPILING… / "q" → reading /
 * amber error) over the waveform pill; clicking the pill opens it. Open: a pill
 * input with focus; Enter asks then closes, Esc cancels.
 */
export function AskBar() {
  const open = useStore((s) => s.askBarOpen);
  const answer = useStore((s) => s.analyticAnswer);
  const ask = useAnalyticAsk();
  const setOpen = (on: boolean) => useStore.getState().setAskBarOpen(on);
  const active = open || answer?.status === 'compiling';
  const caption = askCaption(answer);

  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: DOCK_H + DOCK_GAP,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {open ? (
        <input
          autoFocus
          placeholder="ask about the catalog… (Enter)"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = e.currentTarget.value.trim();
              if (v) {
                ask(v);
                setOpen(false);
              }
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          style={{
            pointerEvents: 'auto',
            width: 'min(560px, 60vw)',
            padding: '6px 14px',
            background: 'oklch(0.05 0.02 250 / 0.6)',
            border: '1px solid var(--hud-glass-edge)',
            borderRadius: 9999,
            outline: 'none',
            textAlign: 'center',
            fontSize: 11,
            letterSpacing: '0.15em',
            color: 'var(--hud-text)',
            fontFamily: 'var(--font-hud-mono)',
          }}
        />
      ) : (
        <div
          style={{
            maxWidth: '70vw',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 10,
            letterSpacing: '0.2em',
            color: caption.error ? 'var(--hud-warn)' : 'var(--hud-text-dim)',
            fontFamily: 'var(--font-hud-mono)',
          }}
        >
          {caption.text}
        </div>
      )}
      <Waveform active={active} onClick={() => setOpen(!open)} />
    </div>
  );
}
