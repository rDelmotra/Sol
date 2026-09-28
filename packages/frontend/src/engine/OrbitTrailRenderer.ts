import * as THREE from 'three';
import * as satellite from 'satellite.js';
import type { OMMJsonObject } from 'satellite.js';
import { simClock } from './SimClock';
import { sourceToSceneInto, writeSourceToScene } from './scene/frames';
import { ER_KM } from '@orbitwatch/orbital-core';

const TRAIL_POINTS = 360;

// Simple internal shaders for the trail glow envelope
const TRAIL_VERT = `
  uniform float uPixelRatio;
  uniform float uPointSize;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    
    // Size attenuation: larger when closer to camera
    // Using a reference scale of 5.0 units
    float size = uPointSize * uPixelRatio * (5.0 / -mvPosition.z);
    gl_PointSize = clamp(size, 1.0, 15.0);
  }
`;

const TRAIL_FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    // gl_PointCoord (0,0 to 1,1) circle calculation
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    
    // Soft radial falloff
    float alpha = 1.0 - smoothstep(0.1, 0.5, dist);
    
    // Additive glow factor
    gl_FragColor = vec4(uColor, alpha * uOpacity);
  }
`;

export class OrbitTrailRenderer {
  private scene: THREE.Scene;
  private line: THREE.Line | null = null;
  private glow: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private lineMaterial: THREE.LineBasicMaterial | null = null;
  private glowMaterial: THREE.ShaderMaterial | null = null;
  private joyrideMode = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  private createTrailObjects(positions: Float32Array, closeLoop: boolean): void {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    this.lineMaterial = new THREE.LineBasicMaterial({
      color: 0x00E5FF,
      transparent: true,
      opacity: this.joyrideMode ? 0.42 : 0.6,
    });
    this.line = closeLoop
      ? new THREE.LineLoop(this.geometry, this.lineMaterial)
      : new THREE.Line(this.geometry, this.lineMaterial);
    this.line.frustumCulled = false;

    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x00E5FF) },
        uPixelRatio: { value: window.devicePixelRatio },
        uPointSize: { value: this.joyrideMode ? 3.8 : 6.0 },
        uOpacity: { value: this.joyrideMode ? 0.18 : 0.4 },
      },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.glow = new THREE.Points(this.geometry, this.glowMaterial);
    this.glow.frustumCulled = false;

    this.scene.add(this.line);
    this.scene.add(this.glow);
  }

  setJoyrideMode(enabled: boolean): void {
    if (this.joyrideMode === enabled) {
      return;
    }
    this.joyrideMode = enabled;
    if (this.lineMaterial) {
      this.lineMaterial.opacity = enabled ? 0.42 : 0.6;
    }
    if (this.glowMaterial) {
      this.glowMaterial.uniforms.uPointSize.value = enabled ? 3.8 : 6.0;
      this.glowMaterial.uniforms.uOpacity.value = enabled ? 0.18 : 0.4;
    }
  }

  generate(omm: OMMJsonObject, anchorTimeMs = simClock.now()): void {
    // Clear any existing trail first
    this.clear();

    const satrec = satellite.json2satrec(omm);

    // Derive orbital period from mean motion (radians/minute)
    const periodMinutes = (2 * Math.PI) / satrec.no;
    const periodMs = periodMinutes * 60 * 1000;
    const now = anchorTimeMs;

    const positions = new Float32Array(TRAIL_POINTS * 3);
    const lastValid = new THREE.Vector3();

    for (let i = 0; i < TRAIL_POINTS; i++) {
      const t = now + (i / TRAIL_POINTS) * periodMs;
      const date = new Date(t);
      const result = satellite.propagate(satrec, date);
      const posEci = result?.position;

      if (posEci && typeof posEci !== 'boolean') {
        // ECI (TEME) km → scene frame, scaled to Earth radii. Carry the last valid
        // sample forward when a propagation step fails.
        sourceToSceneInto(lastValid, posEci.x, posEci.y, posEci.z).multiplyScalar(1 / ER_KM);
      }

      positions[i * 3]     = lastValid.x;
      positions[i * 3 + 1] = lastValid.y;
      positions[i * 3 + 2] = lastValid.z;
    }

    this.createTrailObjects(positions, true);
  }

  /**
   * Builds a DSO trail from packed TEME coordinates [x, y, z, ...] in Earth radii.
   * Uses an open polyline because DSO windows are finite and non-periodic.
   */
  generateFromPositions(positionsTeme: Float32Array): void {
    this.clear();

    const pointCount = Math.floor(positionsTeme.length / 3);
    if (pointCount < 2) {
      return;
    }

    const positions = new Float32Array(pointCount * 3);
    for (let i = 0; i < pointCount; i++) {
      const i3 = i * 3;
      // TEME → Three.js scene frame
      writeSourceToScene(positions, i3, positionsTeme[i3], positionsTeme[i3 + 1], positionsTeme[i3 + 2]);
    }

    this.createTrailObjects(positions, false);
  }

  clear(): void {
    if (this.line) {
      this.scene.remove(this.line);
      this.lineMaterial?.dispose();
      this.line = null;
      this.lineMaterial = null;
    }
    
    if (this.glow) {
      this.scene.remove(this.glow);
      this.glowMaterial?.dispose();
      this.glow = null;
      this.glowMaterial = null;
    }

    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
  }

  dispose(): void {
    this.clear();
  }
}
