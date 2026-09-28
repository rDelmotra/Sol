import * as THREE from 'three';
import dsoVertexShader from '../shaders/dso.vert.glsl?raw';
import dsoFragmentShader from '../shaders/dso.frag.glsl?raw';
import type { DsoObject } from '../data/dso-types';
import { writeSourceToScene } from '../orbital/frames';

const INITIAL_DSO_CAPACITY = 64;
// Base point size passed into the shader (pixels before pixel-ratio scaling)
const DSO_BASE_SIZE = 5.0;

export interface DsoLabelPosition {
  dsoId: string;
  name: string;
  screenX: number;
  screenY: number;
  visible: boolean;
}

export class DsoRenderer {
  readonly mesh: THREE.Points;
  // Geometry is shared with GPUPicker — same attributes, different material
  readonly geometry: THREE.BufferGeometry;

  private currPosAttr: THREE.BufferAttribute;
  private prevPosAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private pickIdAttr: THREE.BufferAttribute;

  private dsoObjects: DsoObject[] = [];
  private tleCount = 0;
  private activeCount = 0;
  private capacity = 0;

  constructor(scene: THREE.Scene) {
    this.geometry = new THREE.BufferGeometry();
    this.currPosAttr = new THREE.BufferAttribute(new Float32Array(0), 3);
    this.prevPosAttr = new THREE.BufferAttribute(new Float32Array(0), 3);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(0), 1);
    this.pickIdAttr = new THREE.BufferAttribute(new Float32Array(0), 3);
    this.allocateAttributes(INITIAL_DSO_CAPACITY);

    const material = new THREE.ShaderMaterial({
      vertexShader:   dsoVertexShader,
      fragmentShader: dsoFragmentShader,
      uniforms: {
        uPixelRatio:       { value: 1.0 },
        uSelectedDsoIndex: { value: -1.0 },
      },
      transparent: true,
      depthWrite:  false,
      blending:    THREE.NormalBlending,
    });

    this.mesh = new THREE.Points(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder   = 1; // draw above TLE cloud
    scene.add(this.mesh);
  }

  private allocateAttributes(capacity: number): void {
    this.capacity = capacity;

    const positions = new Float32Array(capacity * 3);
    const prevPositions = new Float32Array(capacity * 3);
    const sizes = new Float32Array(capacity);
    const pickIds = new Float32Array(capacity * 3);

    this.currPosAttr = new THREE.BufferAttribute(positions, 3);
    this.prevPosAttr = new THREE.BufferAttribute(prevPositions, 3);
    this.sizeAttr = new THREE.BufferAttribute(sizes, 1);
    this.pickIdAttr = new THREE.BufferAttribute(pickIds, 3);

    // 'position' is required by Three.js for bounding-sphere computation
    this.geometry.setAttribute('position', this.currPosAttr);
    this.geometry.setAttribute('currentPosition', this.currPosAttr);
    this.geometry.setAttribute('previousPosition', this.prevPosAttr);
    this.geometry.setAttribute('size', this.sizeAttr);
    this.geometry.setAttribute('pickId', this.pickIdAttr);
    this.geometry.setDrawRange(0, Math.min(this.activeCount, capacity));
  }

  private ensureCapacity(requiredCount: number): void {
    if (requiredCount <= this.capacity) {
      return;
    }

    let nextCapacity = Math.max(this.capacity, INITIAL_DSO_CAPACITY);
    while (nextCapacity < requiredCount) {
      nextCapacity *= 2;
    }

    this.allocateAttributes(nextCapacity);
  }

  get material(): THREE.ShaderMaterial {
    return this.mesh.material as THREE.ShaderMaterial;
  }

  /**
   * (Re-)initialize DSO geometry from a fresh catalog.
   * Safe to call multiple times as DSO catalog loads / updates.
   */
  init(dsoObjects: DsoObject[], tleCount: number): void {
    this.dsoObjects = dsoObjects;
    this.tleCount   = tleCount;
    this.ensureCapacity(dsoObjects.length);

    this.activeCount = dsoObjects.length;
    this.geometry.setDrawRange(0, this.activeCount);

    const pickArr = this.pickIdAttr.array as Float32Array;
    const sizeArr = this.sizeAttr.array as Float32Array;

    for (let i = 0; i < this.activeCount; i++) {
      // Pick IDs sit in the global space above TLE indices
      const encoded = this.tleCount + i + 1; // +1 because 0 = background
      pickArr[i * 3]     = ((encoded >> 16) & 0xFF) / 255;
      pickArr[i * 3 + 1] = ((encoded >> 8)  & 0xFF) / 255;
      pickArr[i * 3 + 2] = ( encoded        & 0xFF) / 255;

      // Start hidden; update methods will set size once ephemeris arrives
      sizeArr[i] = 0;
    }

    this.pickIdAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate   = true;
  }

  /** Applies worker-computed TEME positions + visibility flags each frame. */
  updateFromWorkerBuffers(positionsTeme: Float32Array, visibleFlags: Uint8Array): void {
    const posArr = this.currPosAttr.array as Float32Array;
    const prevArr = this.prevPosAttr.array as Float32Array;
    const sizeArr = this.sizeAttr.array as Float32Array;

    prevArr.set(posArr.subarray(0, this.activeCount * 3));

    const maxCount = Math.min(
      this.activeCount,
      visibleFlags.length,
      Math.floor(positionsTeme.length / 3),
    );

    for (let i = 0; i < this.activeCount; i++) {
      const i3 = i * 3;
      const isVisible = i < maxCount && visibleFlags[i] > 0;

      if (!isVisible) {
        posArr[i3] = posArr[i3 + 1] = posArr[i3 + 2] = 0;
        sizeArr[i] = 0;
        continue;
      }

      // TEME → Three.js scene frame
      writeSourceToScene(posArr, i3, positionsTeme[i3], positionsTeme[i3 + 1], positionsTeme[i3 + 2]);
      sizeArr[i] = DSO_BASE_SIZE;
    }

    this.currPosAttr.needsUpdate = true;
    this.prevPosAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  /** Three.js scene-space position for DSO at the given local index. */
  getPositionAt(dsoIndex: number): THREE.Vector3 {
    const arr = this.currPosAttr.array as Float32Array;
    const i3  = dsoIndex * 3;
    return new THREE.Vector3(arr[i3], arr[i3 + 1], arr[i3 + 2]);
  }

  /** Returns true if the DSO at this index has a valid (non-zero) position. */
  isVisible(dsoIndex: number): boolean {
    const sizeArr = this.sizeAttr.array as Float32Array;
    return sizeArr[dsoIndex] > 0;
  }

  /**
   * Projects all visible DSO world positions to screen coordinates.
   * Called once per frame by Engine; result is stored for the label overlay.
   */
  getScreenPositions(
    camera: THREE.Camera,
    width: number,
    height: number,
  ): DsoLabelPosition[] {
    const v      = new THREE.Vector3();
    const result: DsoLabelPosition[] = [];

    for (let i = 0; i < this.activeCount; i++) {
      const dso     = this.dsoObjects[i];
      const visible = this.isVisible(i);

      v.copy(this.getPositionAt(i));
      v.project(camera);

      // v.z > 1 means the point is behind the camera's near plane
      const behind  = v.z > 1.0;
      const screenX = ((v.x + 1) / 2) * width;
      const screenY = ((1 - v.y) / 2) * height;

      result.push({
        dsoId:   dso.dsoId,
        name:    dso.name,
        screenX,
        screenY,
        visible: visible && !behind,
      });
    }

    return result;
  }

  setSelectedDsoIndex(index: number): void {
    this.material.uniforms.uSelectedDsoIndex.value = index;
  }

  updateUniforms(pixelRatio: number): void {
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
