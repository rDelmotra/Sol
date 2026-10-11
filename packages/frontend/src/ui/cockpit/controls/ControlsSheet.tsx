import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store/useStore';
import {
  KEYBOARD_ROWS,
  META_ROWS,
  MOUSE_ROWS,
  PAD_ONLY_ROWS,
  entryActive,
  type ActivePart,
  type ControlEntry,
} from './controls-sheet';
import { GamepadDiagram } from './GamepadDiagram';
import { BUTTON_RESET } from '../primitives/hud-styles';
import { useElementSize } from '../../hooks/useElementSize';

/** Below this the sheet gets an opaque scrim (the globe behind it would crowd it). */
const ROOMY_MIN_W = 1300;
const ROOMY_MIN_H = 880;

/**
 * The controls sheet, "hands on" view: keyboard / gamepad diagram / mouse.
 * Open state is the store's controlsSheetOpen (`?`, `/`, dock `?` and pad START
 * toggle it elsewhere). Closes on Esc (the cockpit key hook), the × button and a
 * click on the backdrop. Hovering a row lights its parts on the diagram and
 * hovering a diagram part lights its rows. The tour of the spike is not ported.
 */
export function ControlsSheet() {
  const open = useStore((s) => s.controlsSheetOpen);
  if (!open) return null;
  return <Sheet />;
}

function Sheet() {
  const close = () => useStore.getState().setControlsSheetOpen(false);
  const scrimRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { w, h } = useElementSize(scrimRef);
  const roomy = w >= ROOMY_MIN_W && h >= ROOMY_MIN_H;
  const padConnected = useStore((s) => s.gamepadConnected);
  const [hover, setHover] = useState<ActivePart>(null);

  // Focus the close button on open; give focus back on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  return (
    <div
      ref={scrimRef}
      className="hud-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Cockpit controls"
      onClick={close}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'auto',
        background: roomy ? 'transparent' : 'oklch(0.06 0.02 250 / 0.92)',
        animation: 'hud-scrim-in 220ms ease both',
        overflow: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: 24,
          right: 24,
          bottom: 48,
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          pointerEvents: 'auto',
          background: 'oklch(0.08 0.015 250 / 0.78)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid oklch(0.98 0.01 240 / 0.12)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '14px 16px 16px' }}>
          <SectionHeader label="KEYBOARD" right={padConnected ? <PadLive /> : undefined} />
          {KEYBOARD_ROWS.map((item) => (
            <ControlRow key={item.label} item={item} hover={hover} onHover={setHover} />
          ))}
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid oklch(0.98 0.01 240 / 0.06)' }}>
            {META_ROWS.map((item) => (
              <ControlRow key={item.label} item={item} hover={hover} onHover={setHover} />
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px 20px 16px',
            borderLeft: '1px solid oklch(0.98 0.01 240 / 0.08)',
            borderRight: '1px solid oklch(0.98 0.01 240 / 0.08)',
            width: 400,
          }}
        >
          <div
            style={{
              fontSize: 9,
              letterSpacing: '0.18em',
              fontFamily: 'var(--font-hud-mono)',
              color: 'var(--hud-arc-dim)',
              fontWeight: 600,
              marginBottom: 4,
              textAlign: 'center',
            }}
          >
            GAMEPAD
          </div>
          <GamepadDiagram activeId={hover} onHoverPart={setHover} style={{ width: '100%', maxHeight: 280 }} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '14px 16px 16px' }}>
          <SectionHeader label="MOUSE" />
          {MOUSE_ROWS.map((item) => (
            <ControlRow key={item.label} item={item} hover={hover} onHover={setHover} />
          ))}
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid oklch(0.98 0.01 240 / 0.06)' }}>
            <SectionHeader label="GAMEPAD ONLY" />
            {PAD_ONLY_ROWS.map((item) => (
              <ControlRow key={item.label} item={item} hover={hover} onHover={setHover} />
            ))}
          </div>
          <div style={{ marginTop: 'auto', paddingTop: 10, borderTop: '1px solid oklch(0.98 0.01 240 / 0.06)', textAlign: 'center' }}>
            <span style={{ fontSize: 8, fontFamily: 'var(--font-hud-mono)', color: 'oklch(0.94 0.01 240 / 0.25)', letterSpacing: '0.1em' }}>
              HOVER ANY KEY ↔ GAMEPAD HIGHLIGHT
            </span>
          </div>
        </div>
      </div>

      <button
        ref={closeRef}
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
        aria-label="Close cockpit controls"
        style={{
          ...BUTTON_RESET,
          position: 'absolute',
          right: 24,
          bottom: 24,
          display: 'flex',
          height: 22,
          width: 22,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 9999,
          border: '1px solid var(--hud-arc)',
          color: 'var(--hud-text)',
          fontSize: 12,
          lineHeight: 1,
          fontFamily: 'var(--font-hud-mono)',
        }}
      >
        ×
      </button>
    </div>
  );
}

function PadLive() {
  return (
    <span style={{ fontSize: 8, fontFamily: 'var(--font-hud-mono)', color: 'var(--hud-good)', display: 'flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: 'var(--hud-good)',
          display: 'inline-block',
          boxShadow: '0 0 6px var(--hud-good)',
          animation: 'hud-pulse 2s ease infinite',
        }}
      />
      GAMEPAD LIVE
    </span>
  );
}

function SectionHeader({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingBottom: 6,
        marginBottom: 4,
        borderBottom: '1px solid oklch(0.98 0.01 240 / 0.08)',
      }}
    >
      <span style={{ fontSize: 9, letterSpacing: '0.18em', fontFamily: 'var(--font-hud-mono)', color: 'var(--hud-arc-dim)', fontWeight: 600 }}>
        {label}
      </span>
      {right}
    </div>
  );
}

function Keycap({ label, small }: { label: string; small?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: small ? 18 : 22,
        height: small ? 18 : 22,
        padding: '0 5px',
        borderRadius: 4,
        border: '1px solid oklch(0.98 0.01 240 / 0.3)',
        background: 'oklch(0.98 0.01 240 / 0.06)',
        color: 'var(--hud-text)',
        fontSize: small ? 8 : 9,
        fontFamily: 'var(--font-hud-mono)',
        fontWeight: 600,
        letterSpacing: '0.04em',
        lineHeight: 1,
        boxShadow: '0 1px 2px oklch(0 0 0 / 0.25), inset 0 1px 0 oklch(1 0 0 / 0.06)',
      }}
    >
      {label}
    </span>
  );
}

function ControlRow({ item, hover, onHover }: { item: ControlEntry; hover: ActivePart; onHover: (a: ActivePart) => void }) {
  const active = entryActive(item, hover);
  return (
    <div
      onMouseEnter={() => onHover(item.partIds)}
      onMouseLeave={() => onHover(null)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        background: active ? 'oklch(0.7 0.12 220 / 0.1)' : 'transparent',
        borderLeft: active ? '2px solid var(--hud-arc)' : '2px solid transparent',
        transition: 'all 160ms ease',
        filter: active ? 'drop-shadow(0 0 6px oklch(0.9 0.06 220 / 0.4))' : 'none',
      }}
    >
      <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
        {item.keycaps.map((k, i) => (
          <Keycap key={i} label={k} small={item.keycaps.length > 3} />
        ))}
      </div>
      <span
        style={{
          flex: 1,
          fontSize: 10,
          fontFamily: 'var(--font-hud-mono)',
          color: active ? 'var(--hud-text)' : 'var(--hud-text-dim)',
          fontWeight: active ? 600 : 400,
          transition: 'color 160ms ease',
        }}
      >
        {item.label}
      </span>
      <span
        style={{
          fontSize: 8,
          fontFamily: 'var(--font-hud-mono)',
          color: active ? 'var(--hud-arc)' : 'oklch(0.94 0.01 240 / 0.3)',
          letterSpacing: '0.08em',
          flexShrink: 0,
          transition: 'color 160ms ease',
        }}
      >
        {item.pad}
      </span>
    </div>
  );
}
