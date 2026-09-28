import type * as THREE from 'three';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';

/**
 * The window NavigationController has into the rest of the engine's per-frame data.
 *
 * Implemented by a thin adapter in Engine over the renderers + worker clients, so
 * the controller never imports SatelliteRenderer / DsoRenderer / Sgp4WorkerClient /
 * DsoWorkerClient directly. This is the seam that keeps the camera decoupled from the
 * data pipeline (dependency rule: controllers must not reach back into data/layers).
 *
 * All `out*` vectors are filled in place; returned `THREE.Vector3` values are only
 * valid until the next call (callers copy immediately, which they do).
 */
export interface TrackingSource {
  /** True once the first SGP4 propagation has arrived (camera moves are gated on this). */
  isReady(): boolean;
  /** Number of TLE objects in the catalog (bounds checks). */
  getTleCount(): number;
  /** The catalog record for a TLE index, or undefined if out of range (selection metadata). */
  getTleObject(index: number): EnrichedTLEObject | undefined;
  /** Current altitude (km) of a TLE object, from its snapped position. */
  getTleAltitudeKm(index: number): number;
  /** GPU-side interpolation factor (uT) used by the out-of-loop fly-to / select calls. */
  getInterpolationFactor(): number;
  /** Fill outPos/outVel with the interpolated TLE state at uT. Returns false if the index is invalid. */
  getTleKinematics(index: number, uT: number, outPos: THREE.Vector3, outVel: THREE.Vector3): boolean;
  /** Fill outPos/outVel with the current DSO state. Returns false if the DSO isn't renderable yet. */
  getDsoKinematics(dsoIndex: number, outPos: THREE.Vector3, outVel: THREE.Vector3): boolean;
}
