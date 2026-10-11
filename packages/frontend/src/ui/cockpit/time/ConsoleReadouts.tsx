import { useStore } from '../../../store/useStore';
import { LIVE_EPSILON_MS } from '../../../time/time-fields';
import { groupInt } from '../format';
import { formatTimeDelta } from './time-console';

/** Signed "FROM NOW" line, shown only while the sim clock is displaced. */
export function DeltaLine({ open }: { open: boolean }) {
  const simTimeMs = useStore((s) => s.simTimeMs);
  const wallClockMs = useStore((s) => s.wallClockMs);
  if (Math.abs(simTimeMs - wallClockMs) <= LIVE_EPSILON_MS) return null;
  return (
    <div style={{ marginTop: open ? 6 : 0, color: 'var(--hud-warn)', opacity: 0.9 }}>
      {formatTimeDelta(simTimeMs, wallClockMs)} FROM NOW
    </div>
  );
}

/** MODE / TRACKING lines. */
export function StatusLines({ open }: { open: boolean }) {
  const viewMode = useStore((s) => s.viewMode);
  const simRate = useStore((s) => s.simRate);
  const objectCount = useStore((s) => s.objectCount);
  return (
    <>
      <div style={{ marginTop: open ? 6 : 0 }}>MODE {viewMode.toUpperCase()} · {simRate}×</div>
      <div>TRACKING {groupInt(objectCount)} OBJ</div>
    </>
  );
}

/** Input hint under the open console; differs when a gamepad is connected. */
export function ScrubHint() {
  const gamepadConnected = useStore((s) => s.gamepadConnected);
  return (
    <div style={{ marginTop: 6, fontSize: 8, letterSpacing: '0.08em', opacity: 0.5 }}>
      {gamepadConnected ? '▲▼ VALUE · ◄► FIELD · SCROLL OVER DIGITS' : 'SCROLL OVER DIGITS · CLICK A FIELD'}
    </div>
  );
}
