// ============================================================
// ResidentSet — P2, "the resident set" (PROJECT_MAP/09_BUILD_PLAN.md "P2 — The
// resident set"; PROJECT_MAP/08_GODHOOD.md "Step 1 — L1, the tick subscriber").
//
// Holds standing Analytic IR programs and re-evaluates each one every SGP4
// worker tick (~1 Hz), diffing the returned `ids` set against the previous
// tick to report which objects entered/exited. This is the L1 rung of the
// awareness ladder: the system re-runs its own questions between asks instead
// of only answering when a human prompts it.
//
// Deliberately dependency-free: plain data + control flow only. No Three.js,
// no Zustand/store, no engine/* imports (no layer, no Engine). The ONLY
// coupling to the rest of the system is the `AnalyticProgram` / `ExecuteOutcome`
// *types* from the frozen `@orbitwatch/analytic` IR — the same contract every
// other consumer (live-source, backend executor) already depends on. The
// Engine owns *when* `tick()` runs (the worker-tick callback) and *how* a
// program is actually executed (`RunProgramFn`, injected) — this class only
// owns bookkeeping: budget, hashing, diffing, and the delta ring buffer.
// ============================================================

import type { AnalyticProgram, ExecuteOutcome, Stage } from '@orbitwatch/analytic';

/** Which concurrency budget a resident program draws from (see `classifyBudget`).
 *  'timeScan' is also where `sweep` residents land: a sweep is a FAR more
 *  expensive time-stepped scan than a plain filter/aggregate pass (up to
 *  `SWEEP_MAX_OBJECTS` objects x many propagation samples per tick, vs one
 *  full-catalog pass), so it draws from the SAME tight, 2-concurrent budget
 *  rather than getting a third, looser class. */
export type ResidentBudgetClass = 'free' | 'timeScan';

/** Why `add()` refused a program. Never thrown — always returned, typed. */
export type ResidentRejectReason = 'universe-all' | 'timescan-cap' | 'total-cap';

/**
 * `add()`'s result. The plan's one-line shorthand ("add(program): string,
 * returns hash") is the success path; the fuller "Budget" section requires a
 * *typed rejection* rather than a throw, so the real contract is this
 * discriminated union — `hash` on success, a typed `reason` + `message` on
 * refusal, exactly mirroring the `{ok:true|false}` shape already used by
 * `ValidationResult`/`ExecuteOutcome` elsewhere in `@orbitwatch/analytic`.
 */
export type ResidentAddResult =
  | { ok: true; hash: string }
  | { ok: false; reason: ResidentRejectReason; message: string };

/** One entered/exited event. Only emitted when something actually changed. */
export interface ResidentDelta {
  /** Sim/wall time (ms epoch) of the tick that produced this delta. */
  t: number;
  programHash: string;
  entered: number[];
  exited: number[];
}

/** Read-only snapshot of one resident, for a dev console / future UI. */
export interface ResidentInfo {
  programHash: string;
  program: AnalyticProgram;
  budgetClass: ResidentBudgetClass;
  /** Size of the last-known `ids` set (0 before the first successful tick). */
  memberCount: number;
  /** Set once this resident threw during `tick()`; it is then permanently
   *  skipped (never silently retried) until the caller calls `remove()`. */
  erroredMessage: string | null;
}

/**
 * What the Engine hands `tick()` to actually run a program — identical shape
 * to `SatellitesLayer.runAnalyticProgram`, injected so this file never needs
 * to import a layer (or anything engine-shaped) to call it.
 */
export type RunProgramFn = (program: AnalyticProgram) => ExecuteOutcome | { notReady: true };

const TIMESCAN_RESIDENT_CAP = 2;

/**
 * MEASURED, not guessed. The build plan assumed plain filter/aggregate
 * residents were "effectively free (sub-ms)" and set this ceiling at 32. That
 * assumption is wrong by ~10x. Benchmarked in a live browser against the real
 * 32,393-object live catalog (2026-09-09, 25 runs each, median):
 *
 *   plain filter + aggregate, no observer geometry .... 6.4 ms  (min 3.9 / max 16.5)
 *   same filter + elevationDeg (per-object geometry) .. 7.4 ms  (min 5.6 / max 30.2)
 *
 * So `elevationDeg` is nearly free (~1 ms); the floor is the full-catalog scan
 * itself, and it is ~6 ms — about a third of a 16.7 ms frame, per resident,
 * per tick. (Both figures also include a validateProgram() the resident path
 * does NOT repeat, so the true per-tick cost is a little lower.)
 *
 * `tick()` runs synchronously inside the SGP4 worker's onmessage turn, so N
 * residents cost N x ~6 ms of blocking main-thread work in one burst, once a
 * second. At the old cap of 32 that is ~190 ms — roughly 11 dropped frames
 * every second, i.e. a visible stutter that the budget was supposed to prevent.
 * At 4 it is ~25 ms: about one and a half frames, once a second.
 *
 * If more standing programs are ever needed, the right fix is NOT a bigger
 * number here — it is a time budget: execute residents round-robin until the
 * tick has spent its millisecond allowance, and continue with the rest on the
 * next tick. That bounds the cost regardless of resident count or catalog size.
 */
const FREE_RESIDENT_CAP = 4;

const RING_BUFFER_CAP = 1000;

interface ResidentEntry {
  program: AnalyticProgram;
  programHash: string;
  lastIds: Set<number>;
  budgetClass: ResidentBudgetClass;
  erroredMessage: string | null;
}

/** Every stage list a program can carry a `timeScan`/`sweep` in: the main
 *  pipeline and the optional `compare` pipeline (validated identically — see
 *  validate.ts's `checkPipeline`, called once per pipeline). */
function stageListsOf(program: AnalyticProgram): Stage[][] {
  return program.compare ? [program.pipeline, program.compare.pipeline] : [program.pipeline];
}

/** `timeScan` steps the live source N times per resident per tick — expensive
 *  relative to a plain filter/derive/sort/aggregate pass, hence its own,
 *  tighter budget class. `sweep` steps N objects x many samples per tick —
 *  the same shape at a much larger scale — so it draws from the SAME class
 *  rather than a separate, looser one (see `ResidentBudgetClass`'s doc). */
function classifyBudget(program: AnalyticProgram): ResidentBudgetClass {
  const isTimeStepped = (s: Stage): boolean => s.op === 'timeScan' || s.op === 'sweep';
  const hasTimeSteppedStage = stageListsOf(program).some((stages) => stages.some(isTimeStepped));
  return hasTimeSteppedStage ? 'timeScan' : 'free';
}

/**
 * Deterministic structural serialization: object keys sorted recursively, so
 * two programs with identical content but different key-insertion order
 * serialize identically. Plain `JSON.stringify` does NOT have this property
 * (key order follows insertion order) and would hash equivalent programs
 * differently — the bug this function exists to avoid.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',');
  return `{${body}}`;
}

/**
 * FNV-1a, 32-bit, hex-encoded. Fast, synchronous, dependency-free (no
 * `node:crypto`, no Web Crypto `subtle` — both are async and/or unavailable
 * in one of the two runtimes this file executes under: the browser bundle
 * and plain `node:test`). Not cryptographic — it doesn't need to be; it's an
 * identity/dedup key over a resident set capped at ~34 entries, where an
 * accidental collision between two DIFFERENT programs is astronomically
 * unlikely (~1e-7 at this scale) and a collision between two EQUAL programs
 * is the intended, correct behavior (see `add()`'s idempotency note).
 */
function fnv1a32(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Stable hash of an `AnalyticProgram`, exported for callers that want to
 *  predict/compare a hash without going through `add()`. */
export function hashProgram(program: AnalyticProgram): string {
  return fnv1a32(stableStringify(program));
}

export class ResidentSet {
  private entries = new Map<string, ResidentEntry>();
  private ring: ResidentDelta[] = [];

  get size(): number {
    return this.entries.size;
  }

  /**
   * Register a standing program. Budget is enforced HERE, at add time, per
   * PROJECT_MAP/09_BUILD_PLAN.md "P2": `universe:'all'` is rejected outright
   * (server-only — the live source this runs against cannot serve it); a
   * program carrying a `timeScan` stage draws from a tight 2-concurrent
   * budget; everything else draws from a 32-resident sanity ceiling. A
   * rejection is returned, never thrown.
   *
   * Adding a program that is structurally identical (same stable hash) to an
   * already-resident one is idempotent: returns the existing hash, does not
   * create a second entry, and does not consume additional budget.
   */
  add(program: AnalyticProgram): ResidentAddResult {
    if (program.universe === 'all') {
      return {
        ok: false,
        reason: 'universe-all',
        message: "universe:'all' programs are server-only — the live source cannot serve a resident.",
      };
    }

    const hash = hashProgram(program);
    const existing = this.entries.get(hash);
    if (existing) return { ok: true, hash };

    const budgetClass = classifyBudget(program);
    if (budgetClass === 'timeScan') {
      const active = this.countByClass('timeScan');
      if (active >= TIMESCAN_RESIDENT_CAP) {
        return {
          ok: false,
          reason: 'timescan-cap',
          message: `timeScan/sweep residents are capped at ${TIMESCAN_RESIDENT_CAP} concurrent (${active} already active).`,
        };
      }
    } else {
      const active = this.countByClass('free');
      if (active >= FREE_RESIDENT_CAP) {
        return {
          ok: false,
          reason: 'total-cap',
          message: `resident set is capped at ${FREE_RESIDENT_CAP} plain residents (${active} already active).`,
        };
      }
    }

    this.entries.set(hash, {
      program,
      programHash: hash,
      lastIds: new Set<number>(),
      budgetClass,
      erroredMessage: null,
    });
    return { ok: true, hash };
  }

  /** Drop a resident by hash. Returns false if it wasn't present. */
  remove(hash: string): boolean {
    return this.entries.delete(hash);
  }

  /** Drop every resident. Does not touch the delta ring buffer (history of
   *  what happened stays valid even after the residents that caused it are gone). */
  clear(): void {
    this.entries.clear();
  }

  /** Snapshot of every resident, for a dev console / future UI. */
  list(): ResidentInfo[] {
    return Array.from(this.entries.values()).map((e) => ({
      programHash: e.programHash,
      program: e.program,
      budgetClass: e.budgetClass,
      memberCount: e.lastIds.size,
      erroredMessage: e.erroredMessage,
    }));
  }

  /** Most recent deltas, oldest-of-the-window first (append-log order). Pass
   *  no `n` for the full retained ring (cap 1000). */
  getRecentDeltas(n?: number): ResidentDelta[] {
    if (n === undefined || n >= this.ring.length) return this.ring.slice();
    return this.ring.slice(this.ring.length - n);
  }

  /**
   * Re-run every resident against the fresh tick, diff each against its own
   * last-known `ids`, and return only the deltas where something actually
   * changed (a fully quiet tick returns `[]`).
   *
   * CRITICAL invariant: this method must NEVER throw and must NEVER let one
   * resident's failure stop the others from being evaluated. It runs inside
   * `SatellitesLayer.onPositions`, the ~1 Hz worker-tick path of the ONE
   * layer marked `critical: true` — an uncaught throw there escalates via
   * `World.reportLayerFailure` → `Engine.handleCriticalError`, which tears
   * down the globe and shows a fatal error. A bad resident program must be
   * able to do no worse than stop diffing *itself*.
   *
   * - A thrown exception from `runProgram` marks that resident `errored` and
   *   permanently skips it on future ticks (visible via `list()`, cleared by
   *   an explicit `remove()`); it does not remove the entry outright, so the
   *   caller can inspect *why* before deciding to drop it.
   * - `{ notReady: true }` and `{ ok: false, error }` (a typed runtime error,
   *   e.g. E-OBSERVER) are normal, non-fatal, retried-next-tick outcomes —
   *   NOT treated as an error state. `lastIds` is left untouched so a
   *   transient hiccup can't manufacture a spurious mass "exited" event.
   * - A successful outcome whose `result.shape !== 'ids'` (no object identity
   *   to diff — e.g. a scalar/table resident) is likewise a no-op tick: nothing
   *   to compare, so nothing is reported. Such a resident simply never emits
   *   deltas; it is not an error.
   */
  tick(runProgram: RunProgramFn, nowMs: number): ResidentDelta[] {
    const deltas: ResidentDelta[] = [];

    for (const entry of this.entries.values()) {
      if (entry.erroredMessage !== null) continue; // stopped — caller must remove() explicitly

      let outcome: ExecuteOutcome | { notReady: true };
      try {
        outcome = runProgram(entry.program);
      } catch (err) {
        entry.erroredMessage = err instanceof Error ? err.message : String(err);
        continue;
      }

      if ('notReady' in outcome) continue;
      if (!outcome.ok) continue;
      const result = outcome.result;
      if (result.shape !== 'ids' || !result.ids) continue;

      const nextIds = new Set<number>(result.ids);
      const entered: number[] = [];
      const exited: number[] = [];
      for (const id of nextIds) if (!entry.lastIds.has(id)) entered.push(id);
      for (const id of entry.lastIds) if (!nextIds.has(id)) exited.push(id);
      entry.lastIds = nextIds;

      if (entered.length === 0 && exited.length === 0) continue;

      entered.sort((a, b) => a - b);
      exited.sort((a, b) => a - b);
      const delta: ResidentDelta = { t: nowMs, programHash: entry.programHash, entered, exited };
      deltas.push(delta);
      this.ring.push(delta);
      if (this.ring.length > RING_BUFFER_CAP) this.ring.shift();
    }

    return deltas;
  }

  private countByClass(cls: ResidentBudgetClass): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.budgetClass === cls) n++;
    return n;
  }
}
