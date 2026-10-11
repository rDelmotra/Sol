import * as THREE from 'three';
import { altitudeKm, speedKmS, type StateEr } from '@orbitwatch/orbital-core';
import { useStore } from '../../store/useStore';
import { sceneToSourceInto } from '../scene/frames';
import type { TrackingSource } from './TrackingSource';

/** How often the HUD readout is refreshed (ms of wall time). ~4 Hz. */
const PUBLISH_INTERVAL_MS = 250;

/** Positions closer to the centre than this (ER) are the worker's "invalid" zero vector. */
const MIN_VALID_RADIUS_ER = 0.5;

/**
 * Altitude above the WGS84 ellipsoid and speed, from a scene-frame (Y-up) state
 * in earth-radii and earth-radii per second. Rounded to what the HUD can show
 * (0.1 km, 1 m/s) so an unchanged readout is an unchanged value and the store
 * skips the write. Null for the worker's zero vector (object not propagated).
 */
export function liveReadoutFromScene(
  pos: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number },
): { altitudeKm: number; speedKmS: number } | null {
  if (Math.hypot(pos.x, pos.y, pos.z) < MIN_VALID_RADIUS_ER) return null;
  const s: StateEr = {
    r: sceneToSourceInto({ x: 0, y: 0, z: 0 }, pos.x, pos.y, pos.z),
    v: sceneToSourceInto({ x: 0, y: 0, z: 0 }, vel.x, vel.y, vel.z),
  };
  const alt = altitudeKm(s);
  const spd = speedKmS(s);
  if (!Number.isFinite(alt) || !Number.isFinite(spd)) return null;
  return { altitudeKm: Math.round(alt * 10) / 10, speedKmS: Math.round(spd * 1000) / 1000 };
}

/**
 * Pushes the locked object's live altitude and speed to the store at ~4 Hz.
 * Reads the same interpolated state the camera tracks, so the readout always
 * matches what the camera is chasing, and follows a time scrub (sim time).
 */
export class LiveKinematicsPublisher {
  private lastAt = -Infinity;
  private readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();

  constructor(private readonly source: TrackingSource) {}

  /** Call every frame with the wall clock; does work at most every PUBLISH_INTERVAL_MS. */
  tick(wallNowMs: number): void {
    if (wallNowMs - this.lastAt < PUBLISH_INTERVAL_MS) return;
    this.lastAt = wallNowMs;
    const store = useStore.getState();
    const index = store.selectedIndex;
    if (index === null || store.planetarium || !this.source.isReady()) {
      store.setLiveKinematics(null, null);
      return;
    }
    const uT = this.source.getInterpolationFactor();
    const ok = this.source.getTleKinematics(index, uT, this.pos, this.vel);
    const readout = ok ? liveReadoutFromScene(this.pos, this.vel) : null;
    store.setLiveKinematics(readout?.altitudeKm ?? null, readout?.speedKmS ?? null);
  }
}
