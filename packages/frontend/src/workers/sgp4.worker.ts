/**
 * SGP4 Propagation Web Worker
 *
 * Receives TLE data and on each PROPAGATE tick computes ECI (TEME) positions
 * for every object. The batch propagation loop runs in Rust/WASM
 * (packages/wasm-sgp4 — the sgp4 crate) — one call per tick instead of ~32k
 * satellite.js calls. If the WASM module fails to load or initialize
 * (unsupported browser, blocked fetch, corrupt asset), the worker FALLS BACK
 * to the original satellite.js loop: SatellitesLayer is the one critical
 * layer, so a missing optimization must never become a dead app.
 *
 * Output is raw ECI (TEME) coordinates scaled to Earth radii (6371 km = 1.0).
 * No axis swap — the renderer handles ECI → Three.js conversion.
 *
 * Uses double-buffered Transferable ArrayBuffers for zero-copy transfer.
 */

import * as satellite from 'satellite.js';
import { ER_KM, MAX_TSINCE_MIN, withinPropagationWindow } from '@orbitwatch/orbital-core';
import init, { Simulator } from 'wasm-sgp4';
import type {
    TLEInput,
    Sgp4WorkerInMessage as WorkerInMessage,
    Sgp4WorkerOutMessage as WorkerOutMessage,
} from './sgp4-protocol';

// ── State ────────────────────────────────────────────────────────────────────

/** 'wasm' after a successful WASM init; 'js' = satellite.js fallback. */
let engine: 'wasm' | 'js' = 'js';
let sim: Simulator | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
/** WASM module loads once per worker; re-INIT reuses it. */
let wasmInitPromise: Promise<WebAssembly.Memory> | null = null;

let satrecs: satellite.SatRec[] = [];
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

/**
 * Return whichever buffer set is currently available (not detached).
 * If the active set was detached by a previous transfer, reallocate it
 * and swap to the other set for next time.
 */
function getActiveBuffers(): { positions: Float32Array; velocities: Float32Array; validFlags: Uint8Array } {
    if (useSetA) {
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
            void handleInit(msg.tles, msg.startIndex);
            break;
        case 'PROPAGATE':
            // The client only sends PROPAGATE after READY; this guard covers
            // a re-INIT window (async now) where a stale tick could slip in.
            if (isReady) {
                handlePropagate(msg.timestamp, msg.seq);
            }
            break;
    }
};

// ── INIT ─────────────────────────────────────────────────────────────────────

async function handleInit(tles: TLEInput[], start: number): Promise<void> {
    isReady = false;
    startIndex = start;
    objectCount = tles.length;

    try {
        await initWasmEngine(tles);
        engine = 'wasm';
    } catch (err) {
        // Fallback: the original satellite.js path. Slower, but the app lives.
        console.warn('[sgp4.worker] WASM engine unavailable, falling back to satellite.js:', err);
        initJsEngine(tles);
        engine = 'js';
    }

    allocateBuffers(objectCount);

    isReady = true;
    const reply: WorkerOutMessage = { type: 'READY', objectCount };
    (self as unknown as Worker).postMessage(reply);
}

async function initWasmEngine(tles: TLEInput[]): Promise<void> {
    // Load the module once; re-INIT (catalog refresh) reuses the instance.
    if (!wasmInitPromise) {
        wasmInitPromise = init().then((out) => out.memory);
    }
    try {
        wasmMemory = await wasmInitPromise;
    } catch (err) {
        wasmInitPromise = null; // allow a later INIT to retry the load
        throw err;
    }
    sim ??= new Simulator();

    const ommArray = tles.map((tle) => {
        // The Rust sgp4 crate parses EPOCH as chrono::NaiveDateTime, which
        // rejects a trailing 'Z' ("trailing input"). Space-Track/CelesTrak
        // OMM epochs are zoneless in practice; strip defensively.
        const omm = { ...tle.omm };
        if (typeof omm.EPOCH === 'string' && omm.EPOCH.endsWith('Z')) {
            omm.EPOCH = omm.EPOCH.slice(0, -1);
        }
        return omm;
    });

    // Per-object robustness lives in Rust: a bad record becomes an invalid
    // slot (flag 0), it cannot take down the batch. init() itself only throws
    // on a malformed top-level array — treated as engine failure → JS fallback.
    const validCount = sim.init(JSON.stringify(ommArray));
    if (validCount === 0 && objectCount > 0) {
        // Every single record rejected — the WASM parse contract is broken
        // (schema drift?). satellite.js is the safer interpretation.
        throw new Error('wasm-sgp4 rejected all OMM records');
    }
}

function initJsEngine(tles: TLEInput[]): void {
    satrecs = new Array(objectCount);
    for (let i = 0; i < objectCount; i++) {
        try {
            satrecs[i] = satellite.json2satrec(tles[i].omm);
        } catch {
            // If parsing fails, store a placeholder — propagate will flag it invalid
            satrecs[i] = null as unknown as satellite.SatRec;
        }
    }
}

// ── PROPAGATE ────────────────────────────────────────────────────────────────

function handlePropagate(timestamp: number, seq: number): void {
    const { positions, velocities, validFlags } = getActiveBuffers();

    if (engine === 'wasm' && sim && wasmMemory) {
        // Batch-propagate in WASM. MAX_TSINCE_MIN is passed in so the
        // propagation-window policy keeps its ONE home in @orbitwatch/orbital-core
        // (NaN timestamps are rejected by the same in-WASM check).
        sim.propagate(timestamp, MAX_TSINCE_MIN);

        // Views into WASM linear memory — rebuilt every tick because memory
        // growth detaches old views.
        const wasmPositions = new Float32Array(wasmMemory.buffer, sim.positions_ptr(), objectCount * 3);
        const wasmVelocities = new Float32Array(wasmMemory.buffer, sim.velocities_ptr(), objectCount * 3);
        const wasmValidFlags = new Uint8Array(wasmMemory.buffer, sim.valid_flags_ptr(), objectCount);

        positions.set(wasmPositions);
        velocities.set(wasmVelocities);
        validFlags.set(wasmValidFlags);
    } else {
        propagateJs(timestamp, positions, velocities, validFlags);
    }

    const reply: WorkerOutMessage = {
        type: 'POSITIONS',
        positions,
        velocities,
        validFlags,
        startIndex,
        timestamp,
        seq,
    };

    // Transfer ownership (zero-copy). After this, positions.buffer and
    // validFlags.buffer become detached in this worker — length goes to 0.
    // Next tick we'll use the other buffer set (or reallocate if needed).
    (self as unknown as Worker).postMessage(reply, [
        positions.buffer,
        velocities.buffer,
        validFlags.buffer,
    ]);
}

/** The original satellite.js loop — the fallback engine. */
function propagateJs(
    timestamp: number,
    positions: Float32Array,
    velocities: Float32Array,
    validFlags: Uint8Array,
): void {
    const date = new Date(timestamp);

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
        // @orbitwatch/orbital-core (propagation-window.ts).
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
        positions[i3] = posEci.x / ER_KM;
        positions[i3 + 1] = posEci.y / ER_KM;
        positions[i3 + 2] = posEci.z / ER_KM;
        velocities[i3] = velEci.x / ER_KM;
        velocities[i3 + 1] = velEci.y / ER_KM;
        velocities[i3 + 2] = velEci.z / ER_KM;
        validFlags[i] = 1;
    }
}
