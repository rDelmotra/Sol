import * as THREE from 'three';
import { gmst } from '@orbitwatch/orbital-core';
import { useStore } from '../../store/useStore';
import { simClock } from '../../time/SimClock';
import type { GeodeticObserver } from '../../data/types';
import { sceneRayToGeodetic } from '../scene/ground-pick';

/**
 * Where to stand: the ground point under the view centre, else the existing
 * observer location unchanged (keeps a GPS altitude), else nowhere. `moved` says
 * whether the location must be written (and the old place name dropped). Pure.
 */
export function resolveLanding(
  pick: { latDeg: number; lonDeg: number } | null,
  existing: GeodeticObserver | null,
): { landing: GeodeticObserver; moved: boolean } | null {
  if (pick) return { landing: { lat: pick.latDeg, lon: pick.lonDeg, alt: 0 }, moved: true };
  return existing ? { landing: existing, moved: false } : null;
}

/** Land / take off: the store side of the ground vantage, plus the view-ray ground pick. */
export class LandingController {
  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /**
   * Land where the view centre meets the ground: cast the camera's forward ray
   * onto the WGS84 ellipsoid and stand there (ground vantage). Returns whether it
   * landed. Naming the place is the UI's job.
   */
  landWhereLooking(): boolean {
    const store = useStore.getState();
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const pick = sceneRayToGeodetic(this.camera.position, direction, gmst(simClock.now()));
    const result = resolveLanding(pick, store.observerLocation);
    if (!result) return false;
    if (result.moved) {
      store.setObserverPlaceName(null); // the old name describes the old point
      store.setObserverLocation(result.landing);
    }
    store.setVantage('ground');
    return true;
  }

  /** Take off: back to orbit. Same exit path as the ORBIT control (see exitObserverSky). */
  takeOff(): void {
    useStore.getState().setVantage('orbit');
  }

  /** L / pad D-pad down: land if in orbit, take off if on the ground. */
  toggle(): void {
    if (useStore.getState().vantage === 'ground') this.takeOff();
    else this.landWhereLooking();
  }
}
