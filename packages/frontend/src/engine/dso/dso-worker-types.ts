import type { DsoSnapshot } from '@orbitwatch/contracts';

export type DsoWorkerInMessage =
  | {
      type: 'INIT_SNAPSHOTS';
      dsoIds: string[];
      snapshots: Record<string, DsoSnapshot>;
      validToGraceSec?: number;
    }
  | { type: 'SET_DSO_IDS'; dsoIds: string[] }
  | { type: 'UPDATE_SNAPSHOT'; dsoId: string; snapshot: DsoSnapshot | null }
  | { type: 'SET_VALID_TO_GRACE_SEC'; validToGraceSec: number }
  | { type: 'TICK'; timestamp: number }
  | { type: 'BUILD_TRAIL'; dsoId: string; pointCount?: number };

export type DsoWorkerOutMessage =
  | {
      type: 'POSITIONS';
      positions: Float32Array;
      velocities: Float32Array;
      visibleFlags: Uint8Array;
    }
  | { type: 'TRAIL'; dsoId: string; positions: Float32Array };
