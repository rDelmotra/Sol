// ============================================================
// Load gate — "wait for X, but never wait forever".
//
// First visit on a slow link: the satellite catalog (/api/tle/all, ~3.2 MB gz) and
// the Earth textures (~6 MB) used to download in parallel and split the bandwidth,
// so the catalog — the thing that shows satellites — finished late. The textures
// now wait on `catalogGate`, which opens when the catalog request has settled
// (arrived, failed, or came from the local cache) or after a maximum wait.
//
// Pure: no DOM, no three.js, no store. Timers are the only side effect.
// ============================================================

/** How long a waiter holds back before it goes ahead anyway (catalog hung / very slow). */
export const DEFAULT_GATE_MAX_WAIT_MS = 15_000;

export interface LoadGate {
  /** True once {@link settle} has been called. */
  readonly settled: boolean;
  /** Open the gate. Call it on success AND on failure. Safe to call twice. */
  settle(): void;
  /**
   * Resolves when the gate is settled, or after `maxWaitMs`, whichever comes first.
   * Never rejects. Resolves right away if the gate is already settled.
   */
  whenOpen(maxWaitMs?: number): Promise<void>;
}

export function createLoadGate(): LoadGate {
  let settled = false;
  const waiters = new Set<() => void>();

  return {
    get settled() {
      return settled;
    },
    settle() {
      if (settled) return;
      settled = true;
      for (const open of [...waiters]) open();
    },
    whenOpen(maxWaitMs = DEFAULT_GATE_MAX_WAIT_MS) {
      if (settled) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const open = (): void => {
          clearTimeout(timer);
          waiters.delete(open);
          resolve();
        };
        const timer = setTimeout(open, maxWaitMs);
        waiters.add(open);
      });
    },
  };
}

/**
 * Opens when the catalog request has finished one way or another. Settled by
 * `fetchTleCatalog` (tle-client.ts); waited on by the Earth texture loader.
 */
export const catalogGate: LoadGate = createLoadGate();
