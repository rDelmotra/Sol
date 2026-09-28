import * as THREE from 'three';
import type { DsoSnapshot } from '@orbitwatch/contracts';
import { useStore } from '../../store/useStore';
import { sourceToSceneInto } from '../scene/frames';
import type { DsoWorkerInMessage, DsoWorkerOutMessage } from './dso-worker-types';

// ── Constants ────────────────────────────────────────────────────────────────

const DSO_VALID_TO_GRACE_SEC = 600;
const DSO_TRAIL_POINTS = 360;
const DSO_WORKER_RESTART_DELAY_MS = 500;
const DSO_WORKER_STALL_TIMEOUT_MS = 5000;

// ── Client ──────────────────────────────────────────────────────────────────

export class DsoWorkerClient {
  private worker: Worker | null = null;
  private tickInFlight = false;
  private lastTickSentAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private knownIds = new Set<string>();
  private knownSnapshotVersions = new Map<string, string>();
  private velocitiesTeme: Float32Array | null = null;

  private readonly onPositions: (
    positions: Float32Array,
    velocities: Float32Array,
    visibleFlags: Uint8Array,
  ) => void;
  private readonly onTrail: (dsoId: string, positions: Float32Array) => void;

  constructor(callbacks: {
    onPositions: (
      positions: Float32Array,
      velocities: Float32Array,
      visibleFlags: Uint8Array,
    ) => void;
    onTrail: (dsoId: string, positions: Float32Array) => void;
  }) {
    this.onPositions = callbacks.onPositions;
    this.onTrail = callbacks.onTrail;
    this.spawnWorker();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Called every frame. Sends a TICK if not already in-flight.
   * Also checks for stall and restarts the worker if needed.
   */
  tick(timestamp: number): void {
    // Stall check — folded in so Engine only calls one method per frame
    if (
      this.worker &&
      this.tickInFlight &&
      performance.now() - this.lastTickSentAt > DSO_WORKER_STALL_TIMEOUT_MS
    ) {
      console.warn('DSO worker tick timed out; restarting worker');
      this.tickInFlight = false;
      this.scheduleRestart();
    }

    if (this.worker && !this.tickInFlight) {
      this.worker.postMessage({
        type: 'TICK',
        timestamp,
      } satisfies DsoWorkerInMessage);
      this.tickInFlight = true;
      this.lastTickSentAt = performance.now();
    }
  }

  /** Bypass in-flight guard for immediate tick on sim time jump. */
  triggerImmediateTick(timestamp: number): void {
    if (!this.worker) return;
    this.worker.postMessage({
      type: 'TICK',
      timestamp,
    } satisfies DsoWorkerInMessage);
    this.tickInFlight = true;
    this.lastTickSentAt = performance.now();
  }

  /** TEME velocity for a DSO index, converted to Three.js axes (x, z, -y). */
  getDsoVelocity(dsoIndex: number, out: THREE.Vector3): THREE.Vector3 {
    if (this.velocitiesTeme === null || dsoIndex < 0) {
      out.set(0, 0, 0);
      return out;
    }

    const i3 = dsoIndex * 3;
    if (i3 + 2 >= this.velocitiesTeme.length) {
      out.set(0, 0, 0);
      return out;
    }

    const vx = this.velocitiesTeme[i3];
    const vy = this.velocitiesTeme[i3 + 1];
    const vz = this.velocitiesTeme[i3 + 2];
    // TEME -> Three.js scene frame
    return sourceToSceneInto(out, vx, vy, vz);
  }

  syncIds(nextIds: string[]): void {
    if (!this.worker) return;

    const sameSize = this.knownIds.size === nextIds.length;
    const sameMembers = sameSize && nextIds.every((id) => this.knownIds.has(id));
    if (!sameMembers) {
      this.worker.postMessage({
        type: 'SET_DSO_IDS',
        dsoIds: nextIds,
      } satisfies DsoWorkerInMessage);
      this.knownIds = new Set(nextIds);
    }

    // Clean up snapshot versions for IDs that are gone
    for (const knownId of Array.from(this.knownSnapshotVersions.keys())) {
      if (!this.knownIds.has(knownId)) {
        this.knownSnapshotVersions.delete(knownId);
      }
    }
  }

  syncEphemerisDiff(
    prev: Record<string, DsoSnapshot>,
    next: Record<string, DsoSnapshot>,
  ): void {
    if (!this.worker) return;

    const touchedIds = new Set<string>([
      ...Object.keys(prev),
      ...Object.keys(next),
    ]);

    for (const dsoId of touchedIds) {
      const prevVersion = prev[dsoId]?.snapshotVersion ?? null;
      const nextVersion = next[dsoId]?.snapshotVersion ?? null;

      if (prevVersion === nextVersion) continue;

      this.worker.postMessage({
        type: 'UPDATE_SNAPSHOT',
        dsoId,
        snapshot: next[dsoId] ?? null,
      } satisfies DsoWorkerInMessage);

      if (next[dsoId]) {
        this.knownSnapshotVersions.set(dsoId, next[dsoId].snapshotVersion);
      } else {
        this.knownSnapshotVersions.delete(dsoId);
      }
    }
  }

  /**
   * Request trail build for the given DSO.
   * Trail gating (whether to call this at all) is Engine's responsibility.
   */
  requestTrail(dsoId: string): void {
    if (!this.worker) return;
    this.worker.postMessage({
      type: 'BUILD_TRAIL',
      dsoId,
      pointCount: DSO_TRAIL_POINTS,
    } satisfies DsoWorkerInMessage);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.tickInFlight = false;
    this.lastTickSentAt = 0;
    this.velocitiesTeme = null;
    this.knownIds.clear();
    this.knownSnapshotVersions.clear();
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private spawnWorker(): void {
    this.worker?.terminate();
    this.tickInFlight = false;
    this.lastTickSentAt = 0;
    this.velocitiesTeme = null;
    this.knownIds.clear();
    this.knownSnapshotVersions.clear();

    this.worker = new Worker(
      new URL('../../workers/dso.worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.worker.onmessage = (event: MessageEvent<DsoWorkerOutMessage>) => {
      const msg = event.data;

      if (msg.type === 'POSITIONS') {
        this.tickInFlight = false;
        this.lastTickSentAt = 0;
        this.velocitiesTeme = msg.velocities;
        this.onPositions(msg.positions, msg.velocities, msg.visibleFlags);
        return;
      }

      // msg.type === 'TRAIL' — gating is caller's responsibility
      this.onTrail(msg.dsoId, msg.positions);
    };

    this.worker.onerror = (event) => {
      console.error('DSO worker error:', event);
      this.tickInFlight = false;
      this.scheduleRestart();
    };

    this.worker.onmessageerror = (event) => {
      console.error('DSO worker message error:', event);
      this.tickInFlight = false;
      this.scheduleRestart();
    };

    this.bootstrapState();
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnWorker();
    }, DSO_WORKER_RESTART_DELAY_MS);
  }

  private bootstrapState(): void {
    if (!this.worker) return;

    const state = useStore.getState();
    const dsoIds = state.dsoObjects.map((dso) => dso.dsoId);

    this.worker.postMessage({
      type: 'INIT_SNAPSHOTS',
      dsoIds,
      snapshots: state.dsoEphemerisById,
      validToGraceSec: DSO_VALID_TO_GRACE_SEC,
    } satisfies DsoWorkerInMessage);
    this.worker.postMessage({
      type: 'SET_VALID_TO_GRACE_SEC',
      validToGraceSec: DSO_VALID_TO_GRACE_SEC,
    } satisfies DsoWorkerInMessage);

    this.knownIds = new Set(dsoIds);
    this.knownSnapshotVersions.clear();
    for (const [dsoId, snapshot] of Object.entries(state.dsoEphemerisById)) {
      this.knownSnapshotVersions.set(dsoId, snapshot.snapshotVersion);
    }
  }
}
