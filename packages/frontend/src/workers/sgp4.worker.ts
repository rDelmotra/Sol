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

import type { OMMJsonObject } from 'satellite.js';
import init, { Simulator, InitOutput } from 'wasm-sgp4';

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



let sim: Simulator;
let wasmMemory: WebAssembly.Memory;
let startIndex = 0;
let objectCount = 0;
let isReady = false;

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

function getActiveBuffers(): { positions: Float32Array; velocities: Float32Array; validFlags: Uint8Array } {
    if (useSetA) {
        if (!bufferSetA || bufferSetA.positions.buffer.byteLength === 0) {
            bufferSetA = {
                positions: new Float32Array(objectCount * 3),
                velocities: new Float32Array(objectCount * 3),
                validFlags: new Uint8Array(objectCount),
            };
        }
        useSetA = false;
        return bufferSetA;
    } else {
        if (!bufferSetB || bufferSetB.positions.buffer.byteLength === 0) {
            bufferSetB = {
                positions: new Float32Array(objectCount * 3),
                velocities: new Float32Array(objectCount * 3),
                validFlags: new Uint8Array(objectCount),
            };
        }
        useSetA = true;
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
            if (isReady) {
                handlePropagate(msg.timestamp, msg.seq);
            }
            break;
    }
};

// ── INIT ─────────────────────────────────────────────────────────────────────

async function handleInit(tles: TLEInput[], start: number) {
    startIndex = start;
    objectCount = tles.length;

    // Load Wasm module
    const wasm: InitOutput = await init();
    wasmMemory = wasm.memory;
    sim = new Simulator();

    const ommArray = tles.map(tle => {
        // The Rust sgp4 crate uses chrono::NaiveDateTime for the EPOCH field.
        // If the space-track API includes a 'Z' timezone indicator (e.g., "2026-07-17T10:42:13.269888Z"),
        // chrono's NaiveDateTime parser will choke on the 'Z', resulting in a "trailing input" error.
        // We strip it out here before sending to Wasm.
        const omm = { ...tle.omm };
        if (typeof omm.EPOCH === 'string' && omm.EPOCH.endsWith('Z')) {
            omm.EPOCH = omm.EPOCH.slice(0, -1);
        }
        return omm;
    });

    sim.init(JSON.stringify(ommArray));

    allocateBuffers(objectCount);

    isReady = true;
    const reply: WorkerOutMessage = { type: 'READY', objectCount };
    (self as unknown as Worker).postMessage(reply);
}

// ── PROPAGATE ────────────────────────────────────────────────────────────────

function handlePropagate(timestamp: number, seq: number): void {
    // 1. Run simulation in WebAssembly
    sim.propagate(timestamp);

    // 2. Get the active JS double-buffers
    const { positions, velocities, validFlags } = getActiveBuffers();

    // 3. Create views into Wasm memory
    const wasmPositions = new Float32Array(wasmMemory.buffer, sim.positions_ptr(), objectCount * 3);
    const wasmVelocities = new Float32Array(wasmMemory.buffer, sim.velocities_ptr(), objectCount * 3);
    const wasmValidFlags = new Uint8Array(wasmMemory.buffer, sim.valid_flags_ptr(), objectCount);

    // 4. Copy data from Wasm to JS arrays for transfer
    positions.set(wasmPositions);
    velocities.set(wasmVelocities);
    validFlags.set(wasmValidFlags);

    const reply: WorkerOutMessage = {
        type: 'POSITIONS',
        positions,
        velocities,
        validFlags,
        startIndex,
        timestamp,
        seq,
    };

    // 5. Transfer buffers to main thread (zero-copy postMessage)
    (self as unknown as Worker).postMessage(reply, [
        positions.buffer,
        velocities.buffer,
        validFlags.buffer,
    ]);
}
