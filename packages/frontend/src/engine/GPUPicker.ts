import * as THREE from 'three';
import pickingVertexShader from '../shaders/picking.vert.glsl?raw';
import pickingFragmentShader from '../shaders/picking.frag.glsl?raw';
import dsoPickingVertexShader from '../shaders/dso-picking.vert.glsl?raw';
import type { SatelliteRenderer } from './SatelliteRenderer';

const PICK_TARGET_SIZE = 512;
const SAMPLE_RADIUS = 2; // 5×5 pixel area
const SAMPLE_SIZE = SAMPLE_RADIUS * 2 + 1;

export class GPUPicker {
  private readonly renderTarget: THREE.WebGLRenderTarget;
  private readonly pickScene: THREE.Scene;
  private readonly pickMaterial: THREE.ShaderMaterial;
  private readonly dsoPickMaterial: THREE.ShaderMaterial;
  private readonly pickMesh: THREE.Points;
  private readonly earthOccluder: THREE.Mesh;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly pixelBuffer = new Uint8Array(4);
  private readonly areaBuffer = new Uint8Array(SAMPLE_SIZE * SAMPLE_SIZE * 4);
  private catalogSize: number;  // TLE-only count (mutable: changes on a history re-seed)
  private dsoCount = 0;                  // DSO count, set after init
  private dsoPickMesh: THREE.Points | null = null;
  private readonly sizeAttr: THREE.BufferAttribute;

  constructor(
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    satelliteRenderer: SatelliteRenderer,
    catalogSize: number,
  ) {
    this.renderer = renderer;
    this.camera = camera;
    this.catalogSize = catalogSize;
    this.sizeAttr = satelliteRenderer.mesh.geometry.getAttribute('size') as THREE.BufferAttribute;

    this.renderTarget = new THREE.WebGLRenderTarget(PICK_TARGET_SIZE, PICK_TARGET_SIZE, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });
    this.renderTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this.pickMaterial = new THREE.ShaderMaterial({
      vertexShader: pickingVertexShader,
      fragmentShader: pickingFragmentShader,
      uniforms: {
        uPixelRatio: { value: 1.0 },
        uCameraDistance: { value: 5.0 },
        uT: { value: 0.0 },
      },
      depthWrite: true,
      depthTest: true,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    // Separate picking material for DSOs — no distance fade so they remain
    // pickable at deep-space distances (JWST ~235 ER, LRO ~60 ER, etc.)
    this.dsoPickMaterial = new THREE.ShaderMaterial({
      vertexShader: dsoPickingVertexShader,
      fragmentShader: pickingFragmentShader,
      uniforms: {
        uPixelRatio: { value: 1.0 },
        uT: { value: 0.0 },
      },
      depthWrite: true,
      depthTest: true,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    // Share geometry (zero buffer duplication) but use picking material
    this.pickMesh = new THREE.Points(satelliteRenderer.mesh.geometry, this.pickMaterial);
    this.pickMesh.frustumCulled = false;

    // Earth occluder: opaque sphere that blocks picking through Earth.
    // Outputs black (0,0,0) which decodes to index -1 (background).
    this.earthOccluder = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 32, 16),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        toneMapped: false,
      }),
    );

    this.pickScene = new THREE.Scene();
    this.pickScene.add(this.earthOccluder);
    this.pickScene.add(this.pickMesh);
  }

  private renderPickPass(): void {
    const savedRenderTarget = this.renderer.getRenderTarget();
    const savedClearColor = new THREE.Color();
    this.renderer.getClearColor(savedClearColor);
    const savedClearAlpha = this.renderer.getClearAlpha();
    const savedToneMapping = this.renderer.toneMapping;
    const savedOutputColorSpace = this.renderer.outputColorSpace as THREE.ColorSpace;

    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.pickScene, this.camera);

    // Restore is done by the caller after reading pixels
    this._savedState = { savedRenderTarget, savedClearColor, savedClearAlpha, savedToneMapping, savedOutputColorSpace };
  }

  private _savedState: {
    savedRenderTarget: THREE.WebGLRenderTarget | null;
    savedClearColor: THREE.Color;
    savedClearAlpha: number;
    savedToneMapping: THREE.ToneMapping;
    savedOutputColorSpace: THREE.ColorSpace;
  } | null = null;

  private restoreState(): void {
    if (!this._savedState) return;
    const { savedRenderTarget, savedClearColor, savedClearAlpha, savedToneMapping, savedOutputColorSpace } = this._savedState;
    this.renderer.setRenderTarget(savedRenderTarget);
    this.renderer.setClearColor(savedClearColor, savedClearAlpha);
    this.renderer.toneMapping = savedToneMapping;
    this.renderer.outputColorSpace = savedOutputColorSpace;
    this._savedState = null;
  }

  private decodePixel(buffer: Uint8Array, offset: number): number {
    const r = buffer[offset];
    const g = buffer[offset + 1];
    const b = buffer[offset + 2];
    const encoded = (r << 16) | (g << 8) | b;
    return encoded - 1;
  }

  /**
   * Pick with area sampling: read a 5×5 region, return all unique hit indices
   * sorted by visual size (largest first).
   */
  pickArea(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): number[] {
    const pickX = Math.floor((screenX / canvasWidth) * PICK_TARGET_SIZE);
    const pickY = Math.floor(((canvasHeight - screenY) / canvasHeight) * PICK_TARGET_SIZE);

    this.renderPickPass();

    // Clamp sample region to render target bounds
    const x0 = Math.max(0, pickX - SAMPLE_RADIUS);
    const y0 = Math.max(0, pickY - SAMPLE_RADIUS);
    const x1 = Math.min(PICK_TARGET_SIZE - 1, pickX + SAMPLE_RADIUS);
    const y1 = Math.min(PICK_TARGET_SIZE - 1, pickY + SAMPLE_RADIUS);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;

    this.renderer.readRenderTargetPixels(this.renderTarget, x0, y0, w, h, this.areaBuffer);
    this.restoreState();

    // Collect unique indices
    const seen = new Set<number>();
    for (let i = 0; i < w * h; i++) {
      const idx = this.decodePixel(this.areaBuffer, i * 4);
      if (idx >= 0 && idx < this.totalCount) {
        seen.add(idx);
      }
    }

    // Sort by size descending.  DSO indices (>= catalogSize) use a large
    // constant size so they sort to the front when clicked directly.
    const indices = Array.from(seen);
    const sizeOf = (i: number) =>
      i < this.catalogSize ? this.sizeAttr.getX(i) : 5.0;
    indices.sort((a, b) => sizeOf(b) - sizeOf(a));
    return indices;
  }

  /**
   * Single-pixel pick for hover (cheaper than area sampling).
   */
  pickSingle(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): number | null {
    const pickX = Math.floor((screenX / canvasWidth) * PICK_TARGET_SIZE);
    const pickY = Math.floor(((canvasHeight - screenY) / canvasHeight) * PICK_TARGET_SIZE);

    this.renderPickPass();
    this.renderer.readRenderTargetPixels(this.renderTarget, pickX, pickY, 1, 1, this.pixelBuffer);
    this.restoreState();

    const idx = this.decodePixel(this.pixelBuffer, 0);
    if (idx < 0 || idx >= this.totalCount) return null;
    return idx;
  }

  /**
   * Register DSO geometry for picking.  The geometry must have the same
   * attributes as the TLE geometry (previousPosition, currentPosition, size,
   * pickId) so it can share the picking material.  Safe to call multiple times
   * as the DSO catalog grows.
   */
  addDsoGeometry(geometry: THREE.BufferGeometry, dsoCount: number): void {
    if (this.dsoPickMesh) {
      this.pickScene.remove(this.dsoPickMesh);
      this.dsoPickMesh = null;
    }
    if (dsoCount > 0) {
      this.dsoPickMesh = new THREE.Points(geometry, this.dsoPickMaterial);
      this.dsoPickMesh.frustumCulled = false;
      this.pickScene.add(this.dsoPickMesh);
    }
    this.dsoCount = dsoCount;
  }

  private get totalCount(): number {
    return this.catalogSize + this.dsoCount;
  }

  syncUniforms(uT: number, uCameraDistance: number, uPixelRatio: number): void {
    this.pickMaterial.uniforms.uT.value = uT;
    this.pickMaterial.uniforms.uCameraDistance.value = uCameraDistance;
    this.pickMaterial.uniforms.uPixelRatio.value = uPixelRatio;
    this.dsoPickMaterial.uniforms.uT.value = uT;
    this.dsoPickMaterial.uniforms.uPixelRatio.value = uPixelRatio;
  }

  /**
   * Update the TLE catalog size after a historical re-seed. The satellite geometry
   * is shared and stable across a re-seed, so no rebuild is needed — only the index
   * clamp (totalCount) and the DSO base offset depend on this count.
   */
  setCatalogSize(catalogSize: number): void {
    this.catalogSize = catalogSize;
  }

  dispose(): void {
    this.renderTarget.dispose();
    this.pickMaterial.dispose();
    this.dsoPickMaterial.dispose();
    this.pickMesh.parent?.remove(this.pickMesh);
    if (this.dsoPickMesh) {
      this.dsoPickMesh.parent?.remove(this.dsoPickMesh);
      this.dsoPickMesh = null;
    }
    this.earthOccluder.geometry.dispose();
    (this.earthOccluder.material as THREE.Material).dispose();
  }
}
