import * as THREE from 'three';
import { getObserverEarthAnchor } from '../../scene/sky';
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
      const { position: pos, up: normal } = getObserverEarthAnchor(loc.lat, loc.lon, loc.alt);
      this.marker.position.copy(pos);
      // Orient the cone's +Y axis to the local surface normal.
      this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    } else if (this.marker) {
      this.removeMarker();
    }
  }

  update(_frame: FrameContext): void {
    // Hide the marker only while actually in the dome view: the camera sits AT the
    // observer, so the cone would clutter the inside. During joyride/fly-to out of
    // dome the camera is in space, so the marker should show again (like any space
    // view with an observer set) — gate on isDomeView, not visibilityMode alone.
    if (this.marker) {
      this.marker.visible = !isDomeView(useStore.getState());
    }
  }

  dispose(): void {
    this.removeMarker();
    this.parent = null;
  }

  private buildMarker(): THREE.Group {
    // Frustum: 160° FOV (half-angle 80°). radius = height * tan(80°).
    // Shallow height = 0.02 → radiusTop = 0.02 * 5.67 = 0.1134.
    const geo = new THREE.CylinderGeometry(0.1134, 0.002, 0.02, 32, 1, true);
    geo.translate(0, 0.01, 0); // base at (0,0,0)

    const mat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });

    const group = new THREE.Group();

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    group.add(mesh);

    const wireframe = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({
        color: 0xff4444, // faint red
        transparent: true,
        opacity: 0.25,
        depthTest: true,
        depthWrite: false,
      }),
    );
    wireframe.renderOrder = 1;
    group.add(wireframe);

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
