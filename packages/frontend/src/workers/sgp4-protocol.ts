/**
 * SGP4 worker message protocol — the one shared definition used by
 * workers/sgp4.worker.ts and engine/tle/Sgp4WorkerClient.ts.
 *
 * TLEInput stays in data/types (the data tier owns it and must not import
 * from workers/); it is imported here and re-exported for convenience.
 */

import type { TLEInput } from '../data/types';

export type { TLEInput };

export type Sgp4WorkerInMessage =
    | { type: 'INIT'; tles: TLEInput[]; startIndex: number }
    | { type: 'PROPAGATE'; timestamp: number; seq: number };

export type Sgp4WorkerOutMessage =
    | { type: 'READY'; objectCount: number }
    | {
        type: 'POSITIONS';
        positions: Float32Array;
        velocities: Float32Array;
        validFlags: Uint8Array;
        startIndex: number;
        timestamp: number;
        seq: number;
    };
