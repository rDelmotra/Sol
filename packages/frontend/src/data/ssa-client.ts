// ============================================================
// ssa-client.ts — read-only client for /api/ssa (encounters / flybys).
//
// The server is the source of truth for miss distance and Pc; this client only
// fetches and caches. Results are cached in memory per (norad, run id): the data
// changes once per screening run, so a cached object is valid while the latest run
// id is unchanged. The latest run id is itself re-checked at most every
// RUN_TTL_MS (the server serves it with max-age=300).
//
// No store side effects (the store slice calls in). 404 (no run yet) and 503
// (history off) are not errors: they mean "no encounter data".
// ============================================================

import type { ObjectEncounters, SsaRunInfo } from '@orbitwatch/contracts';

// Optional-chained so the module is importable under node:test (tsx).
const API_BASE = import.meta.env?.VITE_API_URL ?? '';

/** How long the latest run id is trusted before it is asked for again. */
export const RUN_TTL_MS = 5 * 60 * 1000;

export type EncounterFetch =
  /** Data for the object (possibly an empty list). */
  | { kind: 'ok'; data: ObjectEncounters }
  /** No screening run exists yet (404). Treated as empty. */
  | { kind: 'none' }
  /** The encounter service is off (503). */
  | { kind: 'unavailable' }
  /** Network or malformed response. */
  | { kind: 'error'; message: string };

type RunFetch =
  | { kind: 'ok'; run: SsaRunInfo }
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

interface RunCache {
  run: SsaRunInfo;
  at: number;
}

let runCache: RunCache | null = null;
let runInFlight: Promise<RunFetch> | null = null;
const objectCache = new Map<string, ObjectEncounters>();
const objectInFlight = new Map<string, Promise<EncounterFetch>>();

/** Forget everything (tests, and a manual refresh). */
export function clearSsaCache(): void {
  runCache = null;
  runInFlight = null;
  objectCache.clear();
  objectInFlight.clear();
}

const message = (err: unknown): string => (err instanceof Error ? err.message : 'network error');

async function fetchRun(now: number): Promise<RunFetch> {
  if (runCache && now - runCache.at < RUN_TTL_MS) return { kind: 'ok', run: runCache.run };
  if (runInFlight) return runInFlight;
  runInFlight = (async (): Promise<RunFetch> => {
    try {
      const res = await fetch(`${API_BASE}/api/ssa/run`);
      if (res.status === 404) return { kind: 'none' };
      if (res.status === 503) return { kind: 'unavailable' };
      if (!res.ok) return { kind: 'error', message: `HTTP ${res.status}` };
      const run = (await res.json()) as SsaRunInfo;
      if (!run || typeof run.id !== 'number') return { kind: 'error', message: 'malformed run' };
      runCache = { run, at: now };
      return { kind: 'ok', run };
    } catch (err) {
      return { kind: 'error', message: message(err) };
    } finally {
      runInFlight = null;
    }
  })();
  return runInFlight;
}

/**
 * Encounters of one object in the latest run. Cached per (norad, run id); a
 * concurrent call for the same object shares the request in flight.
 * `now` is injectable for tests.
 */
export async function fetchObjectEncounters(noradId: number, now = Date.now()): Promise<EncounterFetch> {
  const run = await fetchRun(now);
  if (run.kind !== 'ok') return run;

  const key = `${noradId}:${run.run.id}`;
  const cached = objectCache.get(key);
  if (cached) return { kind: 'ok', data: cached };
  const pending = objectInFlight.get(key);
  if (pending) return pending;

  const p = (async (): Promise<EncounterFetch> => {
    try {
      const res = await fetch(`${API_BASE}/api/ssa/objects/${noradId}`);
      if (res.status === 404) return { kind: 'none' };
      if (res.status === 503) return { kind: 'unavailable' };
      if (!res.ok) return { kind: 'error', message: `HTTP ${res.status}` };
      const data = (await res.json()) as ObjectEncounters;
      if (!data || !Array.isArray(data.encounters)) return { kind: 'error', message: 'malformed response' };
      // Key by the run the server actually answered for, in case a new run landed
      // between the two requests.
      objectCache.set(`${noradId}:${data.run?.id ?? run.run.id}`, data);
      return { kind: 'ok', data };
    } catch (err) {
      return { kind: 'error', message: message(err) };
    } finally {
      objectInFlight.delete(key);
    }
  })();
  objectInFlight.set(key, p);
  return p;
}
