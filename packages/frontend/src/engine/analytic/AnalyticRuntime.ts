import { validateProgram, execute, type AnalyticProgram, type ExecuteOutcome, type AnalyticDataSource } from '@orbitwatch/analytic';
import type { EnrichedTLEObject } from '@orbitwatch/contracts';
import { ResidentSet, type ResidentDelta } from '../resident/ResidentSet';
import type { LiveSourceDeps } from '../../query/analytic/live-source';

/**
 * Raw worker buffers (TEME ER) the live analytic source reads. Declared
 * structurally so the satellites layer never imports query/ for the type.
 * Mirrors `LiveBuffers` in query/analytic/live-source.ts.
 */
export interface LiveBuffersShape {
  positions: Float32Array;
  velocities: Float32Array;
  validFlags: Uint8Array;
  timestamp: number;
}

/** What the runtime needs from the live data owner (implemented by SatellitesLayer). */
export interface LiveDataPort {
  /** True once the owner is activated AND the first worker buffers have arrived. */
  isReady(): boolean;
  /** The owner's own catalog (NOT the timeline's). */
  getCatalog(): EnrichedTLEObject[];
  getLatestBuffers(): LiveBuffersShape | null;
  getVisualNoradIds(): Set<number>;
}

export interface AnalyticRuntimeDeps {
  /** Builds a fresh live source — called once per run(), never cached. */
  createSource: (deps: LiveSourceDeps) => AnalyticDataSource;
  getVocab: LiveSourceDeps['getVocab'];
  getObserver: () => { lat: number; lon: number; alt: number } | null;
  nowMs: () => number;
}

export interface AnalyticDevHooksHost {
  setAnalyticFilter: (ids: Set<number> | null) => void;
}

/**
 * Owns the standing-program {@link ResidentSet} and the one-shot program
 * executor over the live data port. Free of `import.meta.env`; dev hooks are
 * opt-in via {@link installDevHooks}.
 */
export class AnalyticRuntime {
  readonly residentSet = new ResidentSet();

  constructor(
    private readonly port: LiveDataPort,
    private readonly deps: AnalyticRuntimeDeps,
  ) {}

  /**
   * Execute a VALIDATED program over the live data source at the current sim
   * instant + the store observer. Side-effect-free. `{ notReady: true }` before
   * the port has data.
   */
  run = (program: AnalyticProgram): ExecuteOutcome | { notReady: true } => {
    if (!this.port.isReady()) return { notReady: true };
    const port = this.port;
    const src = this.deps.createSource({
      catalog: port.getCatalog(),
      getBuffers: () => port.getLatestBuffers(),
      getVocab: () => this.deps.getVocab(),
      getVisualNoradIds: () => port.getVisualNoradIds(),
    });
    const obs = this.deps.getObserver();
    return execute(program, { live: src }, {
      nowMs: this.deps.nowMs(),
      observer: obs ? { latDeg: obs.lat, lonDeg: obs.lon, altKm: obs.alt } : null,
    });
  };

  /** Per-SGP4-tick resident re-evaluation. Never throws (ResidentSet contract). */
  tick(): ResidentDelta[] {
    return this.residentSet.tick(this.run, this.deps.nowMs());
  }

  /**
   * Dev-only consoles: `window.__analytic(program)` and `window.__resident`.
   * Returns a remover. Callers gate on their own DEV condition.
   */
  installDevHooks(host: AnalyticDevHooksHost): () => void {
    const w = window as unknown as Record<string, unknown>;
    w.__analytic = (program: unknown) => {
      if (program == null) {
        host.setAnalyticFilter(null);
        return { cleared: true };
      }
      const v = validateProgram(program, { nowMs: this.deps.nowMs() });
      if (!v.ok) return { issues: v.issues };
      const out = this.run(v.program);
      if ('notReady' in out) return { notReady: true };
      if (!out.ok) return { error: out.error };
      if (out.result.shape === 'ids' && out.result.ids) {
        host.setAnalyticFilter(new Set(out.result.ids));
      }
      return out.result;
    };
    w.__resident = {
      add: (program: unknown) => {
        const v = validateProgram(program, { nowMs: this.deps.nowMs() });
        if (!v.ok) return { issues: v.issues };
        return this.residentSet.add(v.program);
      },
      remove: (hash: string) => this.residentSet.remove(hash),
      list: () => this.residentSet.list(),
      deltas: (n?: number) => this.residentSet.getRecentDeltas(n),
    };
    console.info('[analytic] window.__analytic(program) ready — null clears the allow-set');
    console.info(
      '[resident] window.__resident.{add,remove,list,deltas} ready — add(program) validates first',
    );
    return () => {
      delete w.__analytic;
      delete w.__resident;
    };
  }

  dispose(): void {
    this.residentSet.clear();
  }
}
