/* tslint:disable */
/* eslint-disable */

export class Simulator {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Parse an OMM JSON ARRAY and initialize one SGP4 slot per record.
     * Errors only if the top-level array itself is malformed (a protocol
     * bug, not a data problem). Returns the count of valid slots.
     */
    init(omm_json: string): number;
    constructor();
    object_count(): number;
    /**
     * Raw pointers into WASM linear memory — the worker wraps them with
     * typed-array views EACH tick (memory may grow and detach old views).
     */
    positions_ptr(): number;
    /**
     * Propagate every object to `timestamp_ms` (Unix ms). Objects farther
     * than `max_tsince_min` minutes from their elset epoch — or a non-finite
     * timestamp — are marked invalid without propagating (see header).
     */
    propagate(timestamp_ms: number, max_tsince_min: number): void;
    valid_flags_ptr(): number;
    velocities_ptr(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_simulator_free: (a: number, b: number) => void;
    readonly simulator_init: (a: number, b: number, c: number) => [number, number, number];
    readonly simulator_new: () => number;
    readonly simulator_object_count: (a: number) => number;
    readonly simulator_positions_ptr: (a: number) => number;
    readonly simulator_propagate: (a: number, b: number, c: number) => void;
    readonly simulator_valid_flags_ptr: (a: number) => number;
    readonly simulator_velocities_ptr: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
