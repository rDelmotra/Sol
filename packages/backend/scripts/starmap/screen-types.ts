// SPIKE — not production. Messages + shared-memory layout between screen-lib.ts (main) and screen-worker.ts.

export interface SharedLayout {
  n: number;
  nSteps: number;
  t0Ms: number;
  dtMs: number;
  /** Float32 [obj][step][3], NaN where SGP4 failed. */
  pos: SharedArrayBuffer;
  /** Float64 N: sieve-0 interval ends incl. pads. */
  lo: SharedArrayBuffer;
  hi: SharedArrayBuffer;
  /** Int32 N: object indices sorted by lo; loS/hiS = lo/hi in that order (Float64). */
  ord: SharedArrayBuffer;
  loS: SharedArrayBuffer;
  hiS: SharedArrayBuffer;
  /** Float64 N*9 wires and N*216 coarse samples (mid-window). */
  wires: SharedArrayBuffer;
  samples: SharedArrayBuffer;
  /** Float64 N: Sieve-1 pad = ellipse pad + drift bound. */
  pad1: SharedArrayBuffer;
}

export interface InitMsg {
  type: 'init';
  omm: Array<Record<string, unknown>>;
  shared: SharedLayout;
}

export type Task =
  | { type: 'fill'; o0: number; o1: number }
  | { type: 'grid'; s0: number; s1: number; stride: number; L: number; D: number; hybrid: boolean; gap: number }
  | { type: 'sieve'; u0: number; u1: number; gap: number; moid: boolean; scan: boolean; D: number; sampleEvery: number; earlyExit: boolean }
  | { type: 'refine'; buf: Int32Array; stride: number; thr: number }
  | { type: 'issScan'; idx: Int32Array; iss: Float64Array; nIss: number; stepMs: number }
  | { type: 'issCoarse'; idx: Int32Array; iss: Float64Array; nIss: number; coarseS: number; R: number; vmax: number };

export interface GridOut { trip: Int32Array; tests: number; skipped: number; cand: number; ms: number }
export interface SieveOut {
  trip: Int32Array; n0: number; n1: number; msEnum: number; msMoid: number; msScan: number;
}
export interface RefineOut { res: Float64Array; ms: number }
export interface IssOut { res: Float64Array }
