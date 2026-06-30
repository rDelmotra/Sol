/**
 * SGP4 Propagation Web Worker
 *
 * Receives TLE data, parses into satrec objects, and on each PROPAGATE tick
 * computes ECI (TEME) positions for every object using satellite.js SGP4/SDP4.
 *
 * Output is raw ECI (TEME) coordinates scaled to Earth radii (6371 km = 1.0).
 * No axis swap — the renderer handles ECI → Three.js conversion.
 *
 * Uses double-buffered Transferable ArrayBuffers for zero-copy transfer.
 */

import * as satellite from 'satellite.js';
import type { OMMJsonObject } from 'satellite.js';
import { withinPropagationWindow } from '../orbital/propagation-limits';

// ── Types ────────────────────────────────────────────────────────────────────

interface TLEInput {
    noradId: number;
    omm: OMMJsonObject;
}

type WorkerInMessage =
    | { type: 'INIT'; tles: TLEInput[]; startIndex: number }
    | { type: 'PROPAGATE'; timestamp: number; seq: number };

type WorkerOutMessage =
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

// ── State ────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

let satrecs: satellite.SatRec[] = [];
let startIndex = 0;
let objectCount = 0;

// Double-buffered output arrays. After a Transferable transfer the buffer is
// detached (length 0), so we keep two sets and alternate.
let bufferSetA: { positions: Float32Array; velocities: Float32Array; validFlags: Uint8Array } | null = null;
let bufferSetB: { positions: Float32Array; velocities: Float32Array; validFlags: Uint8Array } | null = null;
let useSetA = true;

function allocateBuffers(count: number): void {
    bufferSetA = {
        positions: new Float32Array(count * 3),
        velocities: new Float32Array(count * 3),
        validFlags: new Uint8Array(count),
    };
    bufferSetB = {
        positions: new Float32Array(count * 3),
        velocities: new Float32Array(count * 3),
        validFlags: new Uint8Array(count),
    };
}

/**
 * Return whichever buffer set is currently available (not detached).
 * If the active set was detached by a previous transfer, reallocate it
 * and swap to the other set for next time.
 */
function getActiveBuffers(): { positions: Float32Array; velocities: Float32Array; validFlags: Uint8Array } {
    if (useSetA) {
        // If buffer A was detached by a previous Transferable transfer, reallocate
        if (!bufferSetA || bufferSetA.positions.buffer.byteLength === 0) {
            bufferSetA = {
                positions: new Float32Array(objectCount * 3),
                velocities: new Float32Array(objectCount * 3),
                validFlags: new Uint8Array(objectCount),
            };
        }
        useSetA = false; // next call uses B
        return bufferSetA;
    } else {
        if (!bufferSetB || bufferSetB.positions.buffer.byteLength === 0) {
            bufferSetB = {
                positions: new Float32Array(objectCount * 3),
                velocities: new Float32Array(objectCount * 3),
                validFlags: new Uint8Array(objectCount),
            };
        }
        useSetA = true; // next call uses A
        return bufferSetB;
    }
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
    const msg = e.data;

    switch (msg.type) {
        case 'INIT':
            handleInit(msg.tles, msg.startIndex);
            break;
        case 'PROPAGATE':
            handlePropagate(msg.timestamp, msg.seq);
            break;
    }
};

// ── INIT ─────────────────────────────────────────────────────────────────────

function handleInit(tles: TLEInput[], start: number): void {
    startIndex = start;
    objectCount = tles.length;
    satrecs = new Array(objectCount);

    for (let i = 0; i < objectCount; i++) {
        try {
            satrecs[i] = satellite.json2satrec(tles[i].omm);
        } catch {
            // If parsing fails, store a placeholder — propagate will flag it invalid
            satrecs[i] = null as unknown as satellite.SatRec;
        }
    }

    allocateBuffers(objectCount);

    const reply: WorkerOutMessage = { type: 'READY', objectCount };
    (self as unknown as Worker).postMessage(reply);
}

// ── PROPAGATE ────────────────────────────────────────────────────────────────

function handlePropagate(timestamp: number, seq: number): void {
    const date = new Date(timestamp);

    const { positions, velocities, validFlags } = getActiveBuffers();

    // Propagation epoch as a Julian day, computed ONCE for the whole pass (it's the
    // same date for every object). Non-finite timestamps (wheel-overshoot → Invalid
    // Date) become NaN here and are rejected per-object by withinPropagationWindow.
    const jdNow = Number.isFinite(timestamp) ? satellite.jday(date) : NaN;

    const markInvalid = (i: number): void => {
        const i3 = i * 3;
        positions[i3] = 0;
        positions[i3 + 1] = 0;
        positions[i3 + 2] = 0;
        velocities[i3] = 0;
        velocities[i3 + 1] = 0;
        velocities[i3 + 2] = 0;
        validFlags[i] = 0;
    };

    for (let i = 0; i < objectCount; i++) {
        const rec = satrecs[i];

        // Handle null satrec from failed parse
        if (!rec) {
            markInvalid(i);
            continue;
        }

        // HARD CAP: skip objects too far from their element-set epoch BEFORE propagating.
        // satellite.js's deep-space resonance integrator (dspace) steps from epoch in
        // fixed 720-min increments — cost ∝ |tsince| — so an unbounded scrub would wedge
        // this worker in a synchronous loop. Symmetric (far future AND far past). See
        // orbital/propagation-limits.ts.
        if (!withinPropagationWindow(jdNow, rec.jdsatepoch)) {
            markInvalid(i);
            continue;
        }

        // Real throws inside satellite.js must not abort the entire tick — one bad
        // object would otherwise freeze every satellite. Isolate per object.
        let result: ReturnType<typeof satellite.propagate> | null = null;
        try {
            result = satellite.propagate(rec, date);
        } catch {
            markInvalid(i);
            continue;
        }
        const posEci = result?.position;
        const velEci = result?.velocity;

        // propagate returns { position: false } on failure
        if (!posEci || typeof posEci === 'boolean' || !velEci || typeof velEci === 'boolean') {
            markInvalid(i);
            continue;
        }

        // Scale ECI (TEME) from km to Earth radii (6371 km = 1.0)
        const i3 = i * 3;
        positions[i3] = posEci.x / EARTH_RADIUS_KM;
        positions[i3 + 1] = posEci.y / EARTH_RADIUS_KM;
        positions[i3 + 2] = posEci.z / EARTH_RADIUS_KM;
        velocities[i3] = velEci.x / EARTH_RADIUS_KM;
        velocities[i3 + 1] = velEci.y / EARTH_RADIUS_KM;
        velocities[i3 + 2] = velEci.z / EARTH_RADIUS_KM;
        validFlags[i] = 1;
    }

    // Transfer ownership (zero-copy). After this, positions.buffer and
    // validFlags.buffer become detached in this worker — length goes to 0.
    // Next tick we'll use the other buffer set (or reallocate if needed).
    const reply: WorkerOutMessage = {
        type: 'POSITIONS',
        positions,
        velocities,
        validFlags,
        startIndex,
        timestamp,
        seq,
    };

    (self as unknown as Worker).postMessage(reply, [
        positions.buffer,
        velocities.buffer,
        validFlags.buffer,
    ]);
}
