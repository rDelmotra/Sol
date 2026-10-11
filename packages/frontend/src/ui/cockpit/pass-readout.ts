/**
 * Pass readout text, pure (no React, no store); tested in pass-readout.test.ts.
 *
 * One threshold, used everywhere: a pass "counts" above 10° (Pass.aosMs /
 * losMs are the 10° crossings). The horizon span (horizonAosMs / horizonLosMs)
 * is only used to say "LOW" while the object is up but under 10°.
 *   - upcoming         "AOS 4m 12s"                (countdown to the 10° rise)
 *   - up, under 10°    "LOW · AOS 40s" rising, "LOW · BELOW 10°" setting
 *   - above 10°        "OVERHEAD NOW · LOS 6m 3s"  (LOS = the 10° set)
 * A clipped end is a search-window edge, not a real rise or set, so it never
 * gets a countdown (startClipped: no AOS to count to; endClipped: no LOS).
 */
import type { Pass, PassStatus } from '../../sky/passes';
import { DEFAULT_MIN_ELEVATION_DEG } from '../../sky/passes';

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** "SW 224°" for an azimuth in degrees. */
export function bearing(azimuthDeg: number): string {
  const az = ((azimuthDeg % 360) + 360) % 360;
  return `${CARDINALS[Math.round(az / 22.5) % 16]} ${Math.round(az) % 360}°`;
}

/** "4m 12s" under an hour, "1h 05m" above. Never negative. */
export function formatCountdown(deltaMs: number): string {
  const total = Math.max(0, Math.round(deltaMs / 1000));
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  const mins = Math.round(total / 60);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

export interface ReadoutModel {
  /** Object name line (bold), when the readout is about one object. */
  title?: string;
  primary: string;
  /** 'good' = green and bold (overhead now). */
  tone: 'normal' | 'good';
  secondary?: string;
}

export interface ReadoutInput {
  vantage: 'orbit' | 'ground';
  passStatus: PassStatus;
  name: string | undefined;
  pass: Pass | null;
  nowMs: number;
  placeName: string | null;
}

/** What the readout says, or null when it should be absent. */
export function passReadoutModel(i: ReadoutInput): ReadoutModel | null {
  // Gate on vantage, not dome view: dome also needs an observer location, which
  // would hide the very message telling the user to set one.
  if (i.vantage !== 'ground') return null;
  const title = i.name ?? 'SELECTED';
  switch (i.passStatus) {
    case 'no-selection':
    case 'not-on-ground':
      return null;
    case 'no-location':
      return { primary: 'Set your location to compute passes', tone: 'normal' };
    case 'none-found':
      return {
        title,
        primary: `No pass above ${DEFAULT_MIN_ELEVATION_DEG}° in the next 24 hours`,
        tone: 'normal',
        // Offered as the usual reason, not as a diagnosis of this object.
        secondary: 'Objects whose orbits never reach your latitude never rise here',
      };
    case 'ok':
      break;
  }

  const p = i.pass;
  if (!p) return null;
  const now = i.nowMs;
  let primary: string;
  let tone: ReadoutModel['tone'] = 'normal';
  if (now > p.horizonLosMs) {
    primary = 'PASS ENDED';
  } else if (now < p.horizonAosMs) {
    primary = `AOS ${formatCountdown(p.aosMs - now)}`;
  } else if (now < p.aosMs) {
    primary = `LOW · AOS ${formatCountdown(p.aosMs - now)}`;
  } else if (now <= p.losMs) {
    tone = 'good';
    primary = p.endClipped ? 'OVERHEAD NOW' : `OVERHEAD NOW · LOS ${formatCountdown(p.losMs - now)}`;
  } else {
    primary = `LOW · BELOW ${DEFAULT_MIN_ELEVATION_DEG}°`;
  }

  // A clipped pass may culminate outside the search window: the peak is a floor.
  const prefix = p.startClipped || p.endClipped ? 'peak ≥' : 'peak';
  const secondary =
    `${prefix} ${Math.round(p.peakElevationDeg)}° · ${bearing(p.peakAzimuthDeg)}` +
    (i.placeName ? ` · ${i.placeName}` : '');
  return { title, primary, tone, secondary };
}
