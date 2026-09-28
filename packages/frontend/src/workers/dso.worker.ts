import { interpolateDsoPosition } from '../data/dso-interpolator';
import type { DsoSnapshot } from '@orbitwatch/contracts';
import type { DsoWorkerInMessage as WorkerInMessage, DsoWorkerOutMessage as WorkerOutMessage } from '../engine/dso/dso-worker-types';

const DEFAULT_VALID_TO_GRACE_SEC = 600;
const DEFAULT_TRAIL_POINTS = 360;
const MAX_TRAIL_POINTS = 2048;

let dsoIds: string[] = [];
let snapshotsById: Record<string, DsoSnapshot> = {};
let validToGraceMs = DEFAULT_VALID_TO_GRACE_SEC * 1000;

function toClampedGraceMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(seconds * 1000);
}

function clampTrailPointCount(count: number | undefined): number {
  if (!Number.isFinite(count)) return DEFAULT_TRAIL_POINTS;
  const rounded = Math.floor(count as number);
  if (rounded < 2) return 2;
  if (rounded > MAX_TRAIL_POINTS) return MAX_TRAIL_POINTS;
  return rounded;
}

function buildPositions(
  timestamp: number,
): { positions: Float32Array; velocities: Float32Array; visibleFlags: Uint8Array } {
  const count = dsoIds.length;
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const visibleFlags = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const snapshot = snapshotsById[dsoIds[i]];
    if (!snapshot) continue;

    const pos = interpolateDsoPosition(snapshot, timestamp, { validToGraceMs });
    if (!pos) continue;

    const i3 = i * 3;
    positions[i3] = pos.x;
    positions[i3 + 1] = pos.y;
    positions[i3 + 2] = pos.z;
    velocities[i3] = pos.vx;
    velocities[i3 + 1] = pos.vy;
    velocities[i3 + 2] = pos.vz;
    visibleFlags[i] = 1;
  }

  return { positions, velocities, visibleFlags };
}

function buildTrailPositions(dsoId: string, pointCount?: number): Float32Array {
  const snapshot = snapshotsById[dsoId];
  if (!snapshot || snapshot.stateVectors.length === 0) {
    return new Float32Array(0);
  }

  const vectors = snapshot.stateVectors;
  const desiredPoints = clampTrailPointCount(pointCount);

  if (vectors.length <= desiredPoints) {
    const positions = new Float32Array(vectors.length * 3);
    for (let i = 0; i < vectors.length; i++) {
      const i3 = i * 3;
      positions[i3] = vectors[i][1];
      positions[i3 + 1] = vectors[i][2];
      positions[i3 + 2] = vectors[i][3];
    }
    return positions;
  }

  const firstMs = Date.parse(vectors[0][0]);
  const lastMs = Date.parse(vectors[vectors.length - 1][0]);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || lastMs <= firstMs) {
    return new Float32Array(0);
  }

  const positions = new Float32Array(desiredPoints * 3);
  let lastX = 0;
  let lastY = 0;
  let lastZ = 0;

  for (let i = 0; i < desiredPoints; i++) {
    const t = firstMs + ((lastMs - firstMs) * i) / (desiredPoints - 1);
    const pos = interpolateDsoPosition(snapshot, t, { validToGraceMs: 0 });
    if (pos) {
      lastX = pos.x;
      lastY = pos.y;
      lastZ = pos.z;
    }

    const i3 = i * 3;
    positions[i3] = lastX;
    positions[i3 + 1] = lastY;
    positions[i3 + 2] = lastZ;
  }

  return positions;
}

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'INIT_SNAPSHOTS': {
      dsoIds = msg.dsoIds;
      snapshotsById = msg.snapshots;
      if (msg.validToGraceSec !== undefined) {
        validToGraceMs = toClampedGraceMs(msg.validToGraceSec);
      }
      break;
    }
    case 'SET_DSO_IDS':
      dsoIds = msg.dsoIds;
      break;
    case 'UPDATE_SNAPSHOT':
      if (msg.snapshot) {
        snapshotsById[msg.dsoId] = msg.snapshot;
      } else {
        delete snapshotsById[msg.dsoId];
      }
      break;
    case 'SET_VALID_TO_GRACE_SEC':
      validToGraceMs = toClampedGraceMs(msg.validToGraceSec);
      break;
    case 'TICK': {
      const { positions, velocities, visibleFlags } = buildPositions(msg.timestamp);
      const out: WorkerOutMessage = { type: 'POSITIONS', positions, velocities, visibleFlags };
      (self as unknown as Worker).postMessage(out, [
        positions.buffer,
        velocities.buffer,
        visibleFlags.buffer,
      ]);
      break;
    }
    case 'BUILD_TRAIL': {
      const positions = buildTrailPositions(msg.dsoId, msg.pointCount);
      const out: WorkerOutMessage = { type: 'TRAIL', dsoId: msg.dsoId, positions };
      (self as unknown as Worker).postMessage(out, [positions.buffer]);
      break;
    }
  }
};
