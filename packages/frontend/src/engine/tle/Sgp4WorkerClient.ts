import * as THREE from 'three';
import type { TLEInput, WorkerOutMessage } from '../../data/types';
import { simClock } from '../SimClock';
import { sourceToSceneInto } from '../../orbital/frames';

// ── Public types ────────────────────────────────────────────────────────────

export interface Sgp4PositionResult {
  positions: Float32Array;
  velocities: Float32Array;
  validFlags: Uint8Array;
  timestamp: number;
  objectCount: number;
  isSnap: boolean;
}

/**
 * Opaque timing state for GPU interpolation.
 * Engine reads this once per frame — never recomputes timing from raw fields.
 */
export interface TickState {
  /** Interpolation factor [0, 1] between prev and curr position buffers. */
  uT: number;
  /** Propagation interval in wall-clock ms (adjusted for sim rate). */
  intervalMs: number;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class Sgp4WorkerClient {
  private worker: Worker;
  private propagationInterval: ReturnType<typeof setInterval> | null = null;
  private propagationSeq = 0;
  private snapAtOrAfterSeq = -1;

  private _objectCount = 0;
  private _firstPositionReceived = false;
  private _lastTickTime = 0;
  private _lastPropagationTimestampMs = 0;

  private prevVelocitiesTeme: Float32Array | null = null;
  private currVelocitiesTeme: Float32Array | null = null;

  private readonly onReady: (objectCount: number) => void;
  private readonly onPositions: (result: Sgp4PositionResult) => void;

  constructor(
    tles: TLEInput[],
    callbacks: {
      onReady: (objectCount: number) => void;
      onPositions: (result: Sgp4PositionResult) => void;
    },
  ) {
    this.onReady = callbacks.onReady;
    this.onPositions = callbacks.onPositions;

    this.worker = new Worker(
      new URL('../../workers/sgp4.worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
      const msg = e.data;

      if (msg.type === 'READY') {
        this._objectCount = msg.objectCount;
        this._firstPositionReceived = false;

        // First propagation tick
        this.worker.postMessage({
          type: 'PROPAGATE',
          timestamp: simClock.now(),
          seq: ++this.propagationSeq,
        });

        // Start cadence
        this.schedulePropagation();

        this.onReady(msg.objectCount);
        return;
      }

      // msg.type === 'POSITIONS'
      const isSnap =
        this.snapAtOrAfterSeq >= 0 && msg.seq >= this.snapAtOrAfterSeq;
      if (isSnap) {
        this.snapAtOrAfterSeq = -1;
      }

      this.updateVelocityBuffers(msg.velocities);
      this._lastPropagationTimestampMs = msg.timestamp;
      this._lastTickTime = performance.now();

      if (!this._firstPositionReceived) {
        this._firstPositionReceived = true;
      }

      this.onPositions({
        positions: msg.positions,
        velocities: msg.velocities,
        validFlags: msg.validFlags,
        timestamp: msg.timestamp,
        objectCount: this._objectCount,
        isSnap,
      });
    };

    this.worker.postMessage({ type: 'INIT', tles, startIndex: 0 });
  }

  // ── Public readonly state ───────────────────────────────────────────────

  get objectCount(): number {
    return this._objectCount;
  }

  get firstPositionReceived(): boolean {
    return this._firstPositionReceived;
  }

  // ── Timing (single source of truth) ─────────────────────────────────────

  /**
   * Returns the current interpolation state. Engine calls this once per frame
   * and writes `uT` to the shader uniform — it never recomputes timing itself.
   */
  getTickState(): TickState {
    const intervalMs = this.getPropagationIntervalMs();
    let uT = 0.0;
    if (this._lastTickTime > 0) {
      const elapsed = performance.now() - this._lastTickTime;
      uT = Math.min(elapsed / intervalMs, 1.0);
    }
    return { uT, intervalMs };
  }

  /**
   * Current best-estimate propagation timestamp (interpolated between ticks).
   */
  getCurrentPropagationTimestampMs(): number {
    if (this._lastPropagationTimestampMs <= 0 || this._lastTickTime <= 0) {
      return simClock.now();
    }

    const wallElapsedMs = Math.min(
      Math.max(performance.now() - this._lastTickTime, 0),
      this.getPropagationIntervalMs(),
    );
    return this._lastPropagationTimestampMs + wallElapsedMs * simClock.getRate();
  }

  // ── Velocity interpolation ──────────────────────────────────────────────

  /**
   * Linearly interpolates TLE velocity between prev and curr buffers.
   * Returns Three.js axes (TEME x,z,-y swap).
   */
  getInterpolatedVelocity(
    index: number,
    t: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    if (
      this.prevVelocitiesTeme === null ||
      this.currVelocitiesTeme === null ||
      index < 0
    ) {
      out.set(0, 0, 0);
      return out;
    }

    const i3 = index * 3;
    if (
      i3 + 2 >= this.currVelocitiesTeme.length ||
      i3 + 2 >= this.prevVelocitiesTeme.length
    ) {
      out.set(0, 0, 0);
      return out;
    }

    const vx =
      this.prevVelocitiesTeme[i3] +
      (this.currVelocitiesTeme[i3] - this.prevVelocitiesTeme[i3]) * t;
    const vy =
      this.prevVelocitiesTeme[i3 + 1] +
      (this.currVelocitiesTeme[i3 + 1] - this.prevVelocitiesTeme[i3 + 1]) * t;
    const vz =
      this.prevVelocitiesTeme[i3 + 2] +
      (this.currVelocitiesTeme[i3 + 2] - this.prevVelocitiesTeme[i3 + 2]) * t;

    // TEME -> Three.js scene frame
    return sourceToSceneInto(out, vx, vy, vz);
  }

  // ── Sim time jump ───────────────────────────────────────────────────────

  /**
   * Request immediate propagation at current sim time and snap the result
   * (no interpolation tween). Resets interpolation state and reschedules
   * propagation cadence for the current sim rate.
   */
  requestImmediateSnap(): void {
    const jumpSeq = ++this.propagationSeq;
    this.snapAtOrAfterSeq = jumpSeq;
    this.worker.postMessage({
      type: 'PROPAGATE',
      timestamp: simClock.now(),
      seq: jumpSeq,
    });

    // Reset interpolation so we don't tween from old time
    this._lastTickTime = 0;

    // Reschedule for new rate
    this.schedulePropagation();
  }

  // ── Re-seed (historical time-scrub) ──────────────────────────────────────

  /**
   * Re-seed the worker with a new catalog. Posts a fresh INIT — the worker's
   * handleInit rebuilds satrecs, reallocates buffers, replies READY → first
   * PROPAGATE + reschedule (the same path as construction, driven by the existing
   * onmessage handler). Interpolation/velocity state is reset and the next
   * POSITIONS is forced to SNAP so we never tween from the previous catalog.
   */
  reseed(tles: TLEInput[]): void {
    // Drop velocity history — object count may change, so updateVelocityBuffers
    // must reallocate against the new length.
    this.prevVelocitiesTeme = null;
    this.currVelocitiesTeme = null;
    this._lastTickTime = 0;
    this._lastPropagationTimestampMs = 0;

    // Force the first positions after re-INIT to snap (no interpolation tween):
    // the worker's READY handler posts a PROPAGATE with a seq > this marker.
    this.snapAtOrAfterSeq = ++this.propagationSeq;

    this.worker.postMessage({ type: 'INIT', tles, startIndex: 0 });
  }

  // ── Dispose ─────────────────────────────────────────────────────────────

  dispose(): void {
    if (this.propagationInterval !== null) {
      clearInterval(this.propagationInterval);
      this.propagationInterval = null;
    }
    this.worker.terminate();
    this.prevVelocitiesTeme = null;
    this.currVelocitiesTeme = null;
    this._lastPropagationTimestampMs = 0;
    this._lastTickTime = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Propagation interval in wall-clock ms, scaled by sim rate.
   * At 1x: 1000ms. At 10x+: 200ms (5 Hz) so satellites stay
   * synced with Earth rotation and sun direction.
   */
  private getPropagationIntervalMs(): number {
    const rate = Math.abs(simClock.getRate());
    if (rate <= 1) return 1000;
    return Math.max(200, Math.round(1000 / rate));
  }

  private schedulePropagation(): void {
    if (this.propagationInterval !== null) {
      clearInterval(this.propagationInterval);
    }
    const intervalMs = this.getPropagationIntervalMs();
    this.propagationInterval = setInterval(() => {
      this.worker.postMessage({
        type: 'PROPAGATE',
        timestamp: simClock.now(),
        seq: ++this.propagationSeq,
      });
    }, intervalMs);
  }

  private updateVelocityBuffers(velocities: Float32Array): void {
    if (
      this.currVelocitiesTeme === null ||
      this.prevVelocitiesTeme === null
    ) {
      this.currVelocitiesTeme = new Float32Array(velocities.length);
      this.prevVelocitiesTeme = new Float32Array(velocities.length);
      this.currVelocitiesTeme.set(velocities);
      this.prevVelocitiesTeme.set(velocities);
      return;
    }

    if (
      this.currVelocitiesTeme.length !== velocities.length ||
      this.prevVelocitiesTeme.length !== velocities.length
    ) {
      this.currVelocitiesTeme = new Float32Array(velocities.length);
      this.prevVelocitiesTeme = new Float32Array(velocities.length);
      this.currVelocitiesTeme.set(velocities);
      this.prevVelocitiesTeme.set(velocities);
      return;
    }

    this.prevVelocitiesTeme.set(this.currVelocitiesTeme);
    this.currVelocitiesTeme.set(velocities);
  }
}
