/**
 * Dock decisions, pure (no React, no store); tested in dock-modes.test.ts.
 */
import type { CameraMode, SkyLens, TrackingStyle, Vantage } from '../../../store/types';

export type DockMode = 'orbit' | 'ground' | 'joyride';

/** Which MODE segment is lit: a running joyride wins over the vantage. */
export function dockMode(cameraMode: CameraMode, trackingStyle: TrackingStyle, vantage: Vantage): DockMode {
  const joyriding = (cameraMode === 'flying' || cameraMode === 'following') && trackingStyle === 'joyride';
  return joyriding ? 'joyride' : vantage;
}

/** A lens needs a place unless it is ALL; ALL means nothing on the ground. */
export function lensDisabled(lens: SkyLens, hasLocation: boolean, vantage: Vantage): boolean {
  return lens === 'all' ? vantage === 'ground' : !hasLocation;
}

/** One coordinate: 51.4800 → "51.48° N", -0.5 → "0.50° W". */
export function coordStr(v: number, pos: string, neg: string): string {
  return `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`;
}

/** "51.48° N · 0.00° E". */
export function latLonStr(lat: number, lon: number): string {
  return `${coordStr(lat, 'N', 'S')} · ${coordStr(lon, 'E', 'W')}`;
}
