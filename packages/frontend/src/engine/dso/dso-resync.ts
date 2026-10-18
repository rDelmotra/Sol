import type * as THREE from 'three';
import type { DsoObject } from '../../data/dso-types';

/** What a DSO catalog re-sync touches (a structural slice of the renderer, layer callbacks and worker client). */
export interface DsoResyncTargets {
  renderer: { geometry: THREE.BufferGeometry; init(objs: DsoObject[], tleCount: number): void };
  client: { syncIds(ids: string[]): void } | null;
  /** TLE count — DSO pick IDs are encoded above the TLE index space. */
  getTleCount(): number;
  /** Register the (re)built DSO geometry with the GPU picker. */
  onDsoGeometry(geometry: THREE.BufferGeometry, count: number): void;
}

/**
 * Rebuild DSO geometry, picker registration and worker ids. Pick IDs are encoded
 * against the CURRENT TLE count (0 in the planetarium), so this runs on every
 * catalog swap. It never hides anything: visibility comes from the worker's
 * per-object ephemeris window.
 */
export function resyncDsoCatalog(t: DsoResyncTargets, dsoObjects: DsoObject[]): void {
  t.renderer.init(dsoObjects, t.getTleCount());
  t.onDsoGeometry(t.renderer.geometry, dsoObjects.length);
  t.client?.syncIds(dsoObjects.map((dso) => dso.dsoId));
}
