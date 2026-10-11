/**
 * Cockpit HUD readout helpers: formatters and the honest altitude/speed rules.
 * Pure (no React, no store), so they are unit-tested in format.test.ts.
 *
 * Honesty rules (fixes spike bug list item 1):
 * - A live reading comes only from the Engine's SGP4 state (liveAltitudeKm /
 *   liveSpeedKmS). Nothing else is shown as live.
 * - Without a live state the altitude falls back to the MEAN altitude from the
 *   orbital elements, labelled "MEAN ALT". There is no speed fallback: the
 *   spike's circular-orbit sqrt(mu/r) estimate is gone, the row shows a dash.
 * Numbers use en-US grouping ("1,000") so the look does not depend on locale.
 */
import type { EnrichedTLEObject, ObjectCategory, ObjectType } from '@orbitwatch/contracts';
import { ER_KM, MU_KM3_S2, semiMajorAxisKmFromMeanMotion } from '@orbitwatch/orbital-core';

const LOCALE = 'en-US';

export function finite(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export const CATEGORY_LABEL: Record<ObjectCategory, string> = {
  active_satellite: 'Active satellite',
  inactive_satellite: 'Inactive satellite',
  rocket_body: 'Rocket body',
  debris: 'Debris',
  unknown: 'Unknown',
  deep_space: 'Deep space',
};

/** Three-letter class code shown in the reticle, panes and top-right telemetry. */
export function kindCode(t: ObjectType): string {
  return t === 'satellite' ? 'SAT' : t === 'rocket_body' ? 'RKT' : t === 'debris' ? 'DEB' : 'UNK';
}

/** Whole numbers with thousands grouping: 1234.6 → "1,235". */
export function groupInt(v: number): string {
  return Math.round(v).toLocaleString(LOCALE);
}

export const kmStr = (v: number | null | undefined): string => (finite(v) ? `${groupInt(v)} KM` : '—');
/** Live readouts carry 3 decimals; the SGP4 state is precise enough to warrant them. */
export const kmStr3 = (v: number | null | undefined): string =>
  finite(v) ? `${v.toLocaleString(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} KM` : '—';
export const velStr = (v: number | null | undefined): string => (finite(v) ? `${v.toFixed(2)} KM/S` : '—');
export const velStr3 = (v: number | null | undefined): string => (finite(v) ? `${v.toFixed(3)} KM/S` : '—');
export const degStr = (v: number | null | undefined): string => (finite(v) ? `${v.toFixed(2)}°` : '—');
export const minStr = (v: number | null | undefined): string => (finite(v) ? `${v.toFixed(1)} MIN` : '—');

/** Age since launch as "{years}Y {months}M", or null when unknown or in the future. */
export function ageString(launchDate: string | null, nowMs: number): string | null {
  if (!launchDate) return null;
  const then = Date.parse(launchDate);
  if (Number.isNaN(then)) return null;
  const days = (nowMs - then) / 86_400_000;
  if (days < 0) return null;
  const y = Math.floor(days / 365.25);
  const m = Math.floor((days - y * 365.25) / 30.44);
  return `${y}Y ${m}M`;
}

/** "HH:MM:SSZ" of a data timestamp, or a dash. */
export function syncStr(ms: number | null): string {
  return ms ? new Date(ms).toISOString().slice(11, 19) + 'Z' : '—';
}

/** Orbit size from the mean elements. All km / minutes / degrees; NaN when unknown. */
export interface ElementOrbit {
  period: number;
  apogee: number;
  perigee: number;
  inclination: number;
  /** (apogee + perigee) / 2 above a spherical Earth: a MEAN altitude, not a position. */
  meanAltKm: number;
}

/**
 * Orbit numbers, preferring the backend fields and falling back to the OMM
 * (the CelesTrak fetch path omits apogee / perigee / period).
 */
export function elementOrbit(o: EnrichedTLEObject): ElementOrbit {
  const omm = o.omm as unknown as Record<string, unknown>;
  const mm = Number(omm?.MEAN_MOTION); // rev/day
  const ecc = Number(omm?.ECCENTRICITY);
  const a = finite(mm) ? semiMajorAxisKmFromMeanMotion(mm) : null;
  const periodFromOmm = finite(mm) && mm > 0 ? 1440 / mm : NaN;
  const apoFromOmm = a !== null && finite(ecc) ? a * (1 + ecc) - ER_KM : NaN;
  const perFromOmm = a !== null && finite(ecc) ? a * (1 - ecc) - ER_KM : NaN;
  const period = finite(o.period) ? o.period : periodFromOmm;
  const apogee = finite(o.apogee) ? o.apogee : apoFromOmm;
  const perigee = finite(o.perigee) ? o.perigee : perFromOmm;
  const inclination = finite(o.inclination) ? o.inclination : Number(omm?.INCLINATION);
  const meanAltKm = finite(apogee) && finite(perigee) ? (apogee + perigee) / 2 : NaN;
  return { period, apogee, perigee, inclination, meanAltKm };
}

/** An altitude and where it came from. */
export interface AltitudeReading {
  km: number;
  /** True = live SGP4 geodetic altitude. False = mean altitude from the elements. */
  live: boolean;
}

/** Live altitude when the Engine has one, else the elements' mean altitude, else null. */
export function altitudeReading(liveKm: number | null, meanAltKm: number | null | undefined): AltitudeReading | null {
  if (finite(liveKm)) return { km: liveKm, live: true };
  if (finite(meanAltKm)) return { km: meanAltKm, live: false };
  return null;
}

/** Row label that says which altitude it is. */
export function altitudeLabel(r: AltitudeReading | null): string {
  return r && !r.live ? 'MEAN ALT' : 'ALTITUDE';
}

/**
 * Live speed as a fraction of the local escape speed sqrt(2·mu/r), with r from
 * the live altitude over a spherical Earth (ER_KM). A true ratio: every bound
 * orbit is below 1, a circular orbit sits at 1/√2 ≈ 0.71, an eccentric orbit
 * swings toward 1 at perigee. Null without both live values.
 * The geodetic-vs-geocentric altitude gap (≤ ~21 km) moves it by < 0.2 %.
 */
export function escapeFraction(speedKmS: number | null, altKm: number | null): number | null {
  if (!finite(speedKmS) || !finite(altKm)) return null;
  const r = ER_KM + altKm;
  if (r <= 0) return null;
  const vEsc = Math.sqrt((2 * MU_KM3_S2) / r);
  return Math.min(1, Math.max(0, speedKmS / vEsc));
}

/** Free-flight camera speed for the gear readout: 1,000,000 m/s → "1,000" (km/s). */
export function gearSpeedStr(speedMps: number): string {
  return (speedMps / 1000).toLocaleString(LOCALE);
}
