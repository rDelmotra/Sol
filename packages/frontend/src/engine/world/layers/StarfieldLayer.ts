import * as THREE from 'three';
import { StarfieldRenderer } from '../../StarfieldRenderer';
import { getObserverSceneAnchor } from '../../scene/sky';
import { useStore, isDomeView } from '../../../store/useStore';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/** Background starfield (5000 stars). Backdrop; per-frame work only feeds the dome
 *  horizon fade (so stars under the sea don't show through the water). */
export class StarfieldLayer implements Layer {
  readonly name = 'starfield';
  readonly critical = false;

  private renderer: StarfieldRenderer | null = null;
  private scene: LayerContext['scene'] | null = null;
  private readonly up = new THREE.Vector3(0, 1, 0); // scratch

  init(ctx: LayerContext): void {
    this.scene = ctx.scene;
    this.renderer = new StarfieldRenderer();
    ctx.scene.add(this.renderer.object);
  }

  update(frame: FrameContext): void {
    if (!this.renderer) return;
    // Policy: in the dome view, clip stars below the observer's horizon (so they
    // don't show through the sea). The renderer only knows "clip below a plane".
    const state = useStore.getState();
    const dome = isDomeView(state);
    if (dome && state.observerLocation) {
      const loc = state.observerLocation;
      this.up.copy(getObserverSceneAnchor(loc.lat, loc.lon, loc.alt, frame.date).up);
      this.renderer.setHorizonClip(this.up, true);
    } else {
      this.renderer.setHorizonClip(this.up, false);
    }
  }

  dispose(): void {
    if (this.renderer) {
      this.scene?.remove(this.renderer.object);
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
  }
}
