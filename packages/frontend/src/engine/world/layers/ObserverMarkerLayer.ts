import * as THREE from 'three';
import { getObserverECEFPosition } from '../../../orbital/coordinates';
import { useStore, isDomeView } from '../../../store/useStore';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

type ObserverLoc = { lat: number; lon: number; alt: number };

/**
 * The observer location marker — a translucent frustum + wireframe cone showing
 * where the configured ground observer is. Parents to the rotating Earth group
 * (set by the Engine via {@link setParent} after `world.init`) so it tracks GAST,
 * and is built lazily when a location is set. Non-critical.
 *
 * This layer exists to FIX the CLAUDE.md "infrastructure isolation" violation:
 * the mesh used to be built inline in `Engine.ts`. The Engine now only forwards
 * observer-location changes here via a callback (no geometry/material in Engine).
 */
export class ObserverMarkerLayer implements Layer {
  readonly name = 'observer-marker';
  readonly critical = false;

  private parent: THREE.Object3D | null = null;
  private marker: THREE.Group | null = null;

  init(_ctx: LayerContext): void {
    // No scene-root object: the marker parents to the Earth group (via setParent)
    // so it rotates with the Earth, and is created lazily in setLocation().
  }

  /** Engine wires the rotating Earth group as the marker's parent (cross-layer). */
  setParent(group: THREE.Object3D | null): void {
    this.parent = group;
  }

  /** Build / reposition / remove the marker for the given observer location. */
  setLocation(loc: ObserverLoc | null): void {
    if (!this.parent) return;

    if (loc) {
      if (!this.marker) {
        this.marker = this.buildMarker();
        this.parent.add(this.marker);
      }
      const pos = getObserverECEFPosition(loc.lat, loc.lon, loc.alt);
      this.marker.position.copy(pos);
      // Orient the cone's +Y axis to the local surface normal.
      const normal = pos.clone().normalize();
      this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    } else if (this.marker) {
      this.removeMarker();
    }
  }

  update(frame: FrameContext): void {
    if (this.marker) {
      const isDome = isDomeView(useStore.getState());
      const showDome = useStore.getState().showObserverDome;
      this.marker.visible = showDome && !isDome;

      if (this.marker.visible && this.ringMesh) {
        this.time += frame.delta;
        
        // Pulse scale from 1.0 (radius 0.26) to 1.5384 (radius 0.40)
        const progress = (this.time % 2.0) / 2.0;
        const scale = 1.0 + progress * 0.5384; 
        this.ringMesh.scale.set(scale, scale, scale);
        
        // Fade out as it expands
        const material = this.ringMesh.material as THREE.MeshBasicMaterial;
        material.opacity = Math.max(0, 0.8 * (1.0 - progress));
      }
    }
  }

  dispose(): void {
    this.removeMarker();
    this.parent = null;
  }

  private ringMesh: THREE.Mesh | null = null;
  private time = 0;

  private buildMarker(): THREE.Group {
    const group = new THREE.Group();

    // 1. Skydome (Translucent glassmorphism dome & cone sides)
    // Radius 0.28 (approx 1,812km range limit) and thetaLength of 80 degrees (10 degree elevation limit)
    const domeGeo = new THREE.SphereGeometry(0.28, 32, 16, 0, Math.PI * 2, 0, 80 * Math.PI / 180);
    const domeMat = new THREE.MeshBasicMaterial({
      color: 0xB388FF, // Off-purple theme
      transparent: true,
      opacity: 0.12, // Slightly dimmed to avoid overlay clutter
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });
    const domeMesh = new THREE.Mesh(domeGeo, domeMat);
    domeMesh.renderOrder = 1;
    group.add(domeMesh);

    // Cone connecting the observer (ground) to the base of the floating dome cap
    // height = 0.28 * cos(80) = 0.04862, radiusTop = 0.28 * sin(80) = 0.27575
    const coneGeo = new THREE.CylinderGeometry(0.27575, 0.002, 0.04862, 32, 1, true);
    coneGeo.translate(0, 0.04862 / 2, 0); // align bottom with (0,0,0)
    const coneMesh = new THREE.Mesh(coneGeo, domeMat);
    coneMesh.renderOrder = 1;
    group.add(coneMesh);

    // 2. Pulsing holographic ring (surface)
    // Base radius of 0.26 (approx 1,668km ground footprint)
    const ringGeo = new THREE.RingGeometry(0.255, 0.26, 64);
    ringGeo.rotateX(-Math.PI / 2); // Lay flat on the surface
    
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xB388FF,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.renderOrder = 2;
    group.add(ringMesh);
    
    this.ringMesh = ringMesh;

    return group;
  }

  private removeMarker(): void {
    if (!this.marker) return;
    this.marker.parent?.remove(this.marker);
    this.marker.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    this.marker = null;
  }
}
