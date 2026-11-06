// ============================================================
// Ground-pass provider — the `passedOver` function of the Analytic IR ("who passed over India in the last 30 days").
//
// The executor is synchronous and calls passedOver once per object, but the answer is one set for the whole catalog. So the ask route
// calls registry.prepare(program) first: for each distinct passedOver(region, from, to) the provider runs the pass query ONCE
// (ssa/passes: star-map candidates + exact refine of the objects not yet found), memoizes the set of NORAD ids, and passedOver() is
// then a Set lookup. A spec that was not prepared reads null (the object does not match; never "everything matches").
//
// The memo is keyed by the canonical spec (region id, window clipped at now, whole-minute resolution) and kept for a day when the
// window ended before today (past days do not change), ten minutes otherwise. In-flight preparations are shared.
// ============================================================
import type { Pool } from 'pg';
import type { PassedOverExpr } from '@orbitwatch/analytic';
import { GUARANTEE, passedOverSet, resolveRegion, type PassesOpts, type Region } from '../../ssa/passes/index.js';
import { eraFor } from '../../ssa/history/era.js';
import { PrepareError } from '../registry.js';
import type { FieldProvider } from '../types.js';

const DAY_MS = 86_400_000;
const TTL_PAST_MS = DAY_MS;
const TTL_LIVE_MS = 10 * 60_000;
const MAX_MEMO = 16;

export interface PassesProviderDeps {
  /** the history pool, or null when history is unavailable */
  getDb: () => Pool | null;
  /** the query (injectable for tests) */
  passedOverSet?: (pool: Pool, region: Region, fromMs: number, toMs: number, opts: PassesOpts) => Promise<{ ids: Set<number>; missingDays: string[]; clippedToNow: boolean }>;
  nowMs?: () => number;
  /** options for the query (coverage dir, workers) */
  opts?: PassesOpts;
}

export interface PassesProvider extends FieldProvider {
  /** number of memoized specs (tests) */
  memoSize(): number;
}

interface Memo { ids: Set<number>; notes: string[]; expiresAt: number }

export const specKey = (region: Region, fromMs: number, toMs: number): string => `${region.id}|${fromMs}|${toMs}`;

/** The region, window (whole minutes, clipped at now) of an expression. */
export function canonical(spec: PassedOverExpr, nowMs: number): { region: Region; fromMs: number; toMs: number; clipped: boolean } {
  const region = resolveRegion(spec.region);
  const minute = (t: number) => Math.floor(t / 60_000) * 60_000;
  const fromMs = minute(Date.parse(spec.from));
  let toMs = minute(Date.parse(spec.to));
  let clipped = false;
  if (toMs > nowMs) { toMs = minute(nowMs); clipped = true; }
  return { region, fromMs, toMs, clipped };
}

export function createPassesProvider(deps: PassesProviderDeps): PassesProvider {
  const memo = new Map<string, Memo>();
  const inflight = new Map<string, Promise<Memo>>();
  const now = deps.nowMs ?? Date.now;
  const run = deps.passedOverSet ?? passedOverSet;

  // The memo key a spec was prepared under (the window is cut at the preparation time, so it cannot be recomputed later).
  const bound = new Map<string, string>();

  async function load(spec: PassedOverExpr, nowMs: number): Promise<Memo> {
    const c = canonical(spec, nowMs);
    if (c.toMs <= c.fromMs) return { ids: new Set(), notes: ['The window is entirely in the future: no passes have happened yet.'], expiresAt: nowMs + TTL_LIVE_MS };
    const key = specKey(c.region, c.fromMs, c.toMs);
    bound.set(JSON.stringify(spec), key);
    if (bound.size > 4 * MAX_MEMO) bound.delete(bound.keys().next().value as string);
    const hit = memo.get(key);
    if (hit && hit.expiresAt > nowMs) { memo.delete(key); memo.set(key, hit); return hit; }
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = (async (): Promise<Memo> => {
      const db = deps.getDb();
      if (!db) throw new PrepareError('ground-pass data needs the history database, which is not available');
      const r = await run(db, c.region, c.fromMs, c.toMs, { ...(deps.opts ?? {}), nowMs });
      // every answer carries the guarantee, whatever the compiler wrote in its interpretation
      const notes: string[] = [GUARANTEE];
      if (c.clipped) notes.push('The window ends in the future; it was cut at the current time.');
      if (r.missingDays.length) notes.push(`No coverage data for ${r.missingDays.length} day(s) of the window (${r.missingDays.slice(0, 5).join(', ')}${r.missingDays.length > 5 ? ', …' : ''}): objects that passed only on those days are not listed.`);
      // History: element sets before 1980 are sparse and fitted for older models; say how far positions may be off
      const acc = eraFor(new Date(c.fromMs).toISOString().slice(0, 10)).accuracy;
      if (acc && c.fromMs < Date.parse('1980-01-01T00:00:00Z')) {
        notes.push(`The window starts in ${new Date(c.fromMs).getUTCFullYear()}: element sets of that era are sparse and old (typical position error ${acc.medianKm} km, 95th percentile ${acc.p95Km} km), so objects near the region's edge may be wrongly in or out.`);
      }
      if (c.region.approximate) notes.push(`The ${c.region.name} outline is approximate.`);
      const settled = c.toMs <= Math.floor(nowMs / DAY_MS) * DAY_MS && r.missingDays.length === 0;
      const m: Memo = { ids: r.ids, notes, expiresAt: nowMs + (settled ? TTL_PAST_MS : TTL_LIVE_MS) };
      memo.set(key, m);
      while (memo.size > MAX_MEMO) memo.delete(memo.keys().next().value as string);
      return m;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }

  return {
    id: 'passes',
    fields: [],
    fns: ['passedOver'],
    getField: () => null,
    memoSize: () => memo.size,
    async preparePassedOver(spec, nowMs) {
      return (await load(spec, nowMs)).notes;
    },
    passedOver(noradId, spec) {
      const k = bound.get(JSON.stringify(spec));
      const m = k ? memo.get(k) : undefined;
      return m ? m.ids.has(noradId) : null;
    },
  };
}
