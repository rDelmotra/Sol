import type * as THREE from 'three';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import type { ValidationReport } from '../store/devStore';
import { useDevStore } from '../store/devStore';
import { altitudeKmFromEr } from '@orbitwatch/orbital-core';

const FRAME_SAMPLES = 60;

export class DevValidation {
  private issIndex = -1;
  private geoIndices: number[] = [];
  private lastTickTime = 0;
  private lastWorkerTickMs = 0;

  /** Renderer for GPU/draw diagnostics (WebGLRenderer.info); null in non-GL contexts. */
  private readonly renderer: THREE.WebGLRenderer | null;
  /** Unmasked GPU string, read once and cached. */
  private gpu: string | null = null;

  constructor(renderer: THREE.WebGLRenderer | null = null) {
    this.renderer = renderer;
  }

  /** Lazily reads the unmasked GPU renderer string once (WEBGL_debug_renderer_info). */
  private readGpu(r: THREE.WebGLRenderer): string {
    if (this.gpu !== null) return this.gpu;
    try {
      const gl = r.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = ext
        ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
        : 'unknown';
    } catch {
      this.gpu = 'unknown';
    }
    return this.gpu;
  }

  // Frame timing ring buffer
  private frameTimes: Float64Array = new Float64Array(FRAME_SAMPLES);
  private frameIndex = 0;
  private frameFilled = false;
  private lastFrameTime = 0;

  initFromCatalog(catalogData: EnrichedTLEObject[]): void {
    this.issIndex = catalogData.findIndex((d) => d.noradId === 25544);
    this.geoIndices = [];
    for (let i = 0; i < catalogData.length; i++) {
      if (catalogData[i].regime === 'GEO') {
        this.geoIndices.push(i);
      }
    }
  }

  runChecks(
    positions: Float32Array,
    validFlags: Uint8Array,
    count: number,
  ): void {
    const now = performance.now();
    if (this.lastTickTime > 0) {
      this.lastWorkerTickMs = now - this.lastTickTime;
    }
    this.lastTickTime = now;

    // ISS altitude
    let issAltitudeKm: number | null = null;
    let issAltitudeOk = true;
    if (this.issIndex >= 0 && validFlags[this.issIndex] === 1) {
      const i3 = this.issIndex * 3;
      const x = positions[i3], y = positions[i3 + 1], z = positions[i3 + 2];
      issAltitudeKm = altitudeKmFromEr({ x, y, z });
      issAltitudeOk = issAltitudeKm >= 350 && issAltitudeKm <= 450;
    }

    // GEO radius
    let geoSum = 0;
    let geoValid = 0;
    for (const idx of this.geoIndices) {
      if (validFlags[idx] === 0) continue;
      const i3 = idx * 3;
      const x = positions[i3], y = positions[i3 + 1], z = positions[i3 + 2];
      geoSum += Math.sqrt(x * x + y * y + z * z);
      geoValid++;
    }
    const geoAvgMagnitude = geoValid > 0 ? geoSum / geoValid : 0;
    const geoOk = geoValid === 0 || (geoAvgMagnitude >= 6.32 && geoAvgMagnitude <= 6.92);

    // Inside Earth check
    let insideEarthCount = 0;
    let totalValid = 0;
    let propagationFailures = 0;
    for (let i = 0; i < count; i++) {
      if (validFlags[i] === 0) {
        propagationFailures++;
        continue;
      }
      totalValid++;
      const i3 = i * 3;
      const x = positions[i3], y = positions[i3 + 1], z = positions[i3 + 2];
      const magSq = x * x + y * y + z * z;
      if (magSq > 0.000001 && magSq < 1.0) {
        insideEarthCount++;
      }
    }

    // Frame timing
    const sampleCount = this.frameFilled ? FRAME_SAMPLES : this.frameIndex;
    let frameTimeMs = 0;
    if (sampleCount > 0) {
      let sum = 0;
      for (let i = 0; i < sampleCount; i++) sum += this.frameTimes[i];
      frameTimeMs = sum / sampleCount;
    }
    const fps = frameTimeMs > 0 ? 1000 / frameTimeMs : 0;

    const report: ValidationReport = {
      issAltitudeKm: issAltitudeKm !== null ? Math.round(issAltitudeKm) : null,
      issAltitudeOk,
      geoAvgMagnitude: Math.round(geoAvgMagnitude * 1000) / 1000,
      geoCount: geoValid,
      geoOk,
      insideEarthCount,
      insideEarthOk: insideEarthCount === 0,
      totalLoaded: count,
      totalValid,
      propagationFailures,
      workerTickMs: Math.round(this.lastWorkerTickMs),
      frameTimeMs: Math.round(frameTimeMs * 100) / 100,
      fps: Math.round(fps),
      // renderer.info.render is reset per render(); read here (off the render loop) it
      // reflects the most recently completed frame — fine for a ~1 Hz readout.
      drawCalls: this.renderer?.info.render.calls ?? 0,
      triangles: this.renderer?.info.render.triangles ?? 0,
      textures: this.renderer?.info.memory.textures ?? 0,
      geometries: this.renderer?.info.memory.geometries ?? 0,
      gpu: this.renderer ? this.readGpu(this.renderer) : 'n/a',
    };

    useDevStore.getState().setReport(report);
  }

  tickFrame(): void {
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      this.frameTimes[this.frameIndex] = now - this.lastFrameTime;
      this.frameIndex++;
      if (this.frameIndex >= FRAME_SAMPLES) {
        this.frameIndex = 0;
        this.frameFilled = true;
      }
    }
    this.lastFrameTime = now;
  }
}
