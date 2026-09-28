import * as THREE from 'three';
import { EarthRenderer } from '../../EarthRenderer';
import { useStore, isDomeView } from '../../../store/useStore';
import type { FrameContext, Layer, LayerContext } from '../../render/Layer';

/**
 * Earth globe (inlined GLSL in {@link EarthRenderer}). This is the single seam
 * for the Earth model + cloud colour — a future tiled Earth (Takram) replaces
 * the renderer behind this layer. Non-critical: if it throws, the rest of the
 * scene still renders.
 */
export class EarthLayer implements Layer {
  readonly name = 'earth';
  readonly critical = false;

  private earthRenderer: EarthRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  /**
   * The rotating Earth group (GAST applied to `rotation.y`). Other layers that
   * must rotate with the Earth (e.g. the observer marker) parent to this.
   * Null until {@link init} has run.
   */
  get group(): THREE.Group | null {
    return this.earthRenderer?.object ?? null;
  }

  init(ctx: LayerContext): void {
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.earthRenderer = new EarthRenderer(ctx.maxAnisotropy, ctx.renderer, ctx.camera);
    ctx.scene.add(this.earthRenderer.object);
  }

  update(frame: FrameContext): void {
    if (!this.earthRenderer || !this.camera) return;
    this.earthRenderer.sunDirection.copy(frame.sunDirectionECI);
    // Keep rotating the group even in dome mode: the compass labels / observer
    // marker are parented to it and must keep tracking geography via GAST.
    this.earthRenderer.object.rotation.y = frame.gastRadians;
    this.earthRenderer.update(frame.delta, this.camera);
    // Drop the from‑space globe/clouds/atmosphere only while actually in the dome
    // observer view (DomeSkyLayer renders a ground‑level sky instead). Joyride/fly‑to
    // out of dome flips cameraMode away from 'free', so the Earth reappears for those.
    // The group stays visible regardless, for its parented (compass/marker) children.
    this.earthRenderer.setSurfaceVisible(!isDomeView(useStore.getState()));
  }

  dispose(): void {
    if (this.earthRenderer) {
      this.scene?.remove(this.earthRenderer.object);
      this.earthRenderer.dispose();
      this.earthRenderer = null;
    }
    this.scene = null;
    this.camera = null;
  }
}
