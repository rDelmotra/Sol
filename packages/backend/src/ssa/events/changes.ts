// ============================================================
// deriveChanges: object.appeared, object.disappeared and elements.jump of one UTC day, from the catalog before it and the catalog
// at its end. A pure port of diffEvents() in scripts/starmap/derive-day.ts with the same classification rules, thresholds and
// payloads, minus the fields that need files production does not have (see the dropped list below).
//
// Dropped payload fields (spike -> here):
//   object.disappeared  satcat  (GCAT/SATCAT "truth" hint from a 2026-07-03 snapshot, only ever a hindsight label)
//                       live    (membership of the live tle-cache.json; production has no such snapshot)
//   The spike's `confusion` statistic (class x satcat status) goes with them.
// "returned" needs the day an object was first catalogued: the caller passes it in (object_dim.first_seen in production,
// the spike's firstseen.json in the parity test); without it every unseen object is `newly_cataloged` unless launched < 31 days ago.
// ============================================================
import { geodeticLatAltFromEr, ER_KM } from '@orbitwatch/orbital-core';
import { epochMsOf } from '../encounter.js';
import { jumpMetrics, makeProp, posAt } from './orbit.js';
import { DAY_MS, JUMP_DA_KM, JUMP_DPOS_KM, type ChangeObject, type EventRow } from './types.js';

export interface ChangeStats {
  appeared: number;
  disappeared: number;
  jumps: number;
  changedElsets: number;
  jumpFailed: number;
  appClass: Record<string, number>;
  disClass: Record<string, number>;
  jumpDir: Record<string, number>;
}

export interface DeriveChangesOpts {
  /** NORAD id -> 'YYYY-MM-DD' of the first day the object was in a catalog (for the `returned` class) */
  firstSeen?: (noradId: number) => string | undefined;
  /** orbit-change thresholds (defaults: JUMP_DPOS_KM / JUMP_DA_KM). The history backfill sets them per era. */
  jumpDposKm?: number;
  jumpDaKm?: number;
}

export function deriveChanges(prev: ChangeObject[], cur: ChangeObject[], dayStartMs: number, opts: DeriveChangesOpts = {}): { rows: EventRow[]; stats: ChangeStats } {
  const day = new Date(dayStartMs).toISOString().slice(0, 10);
  const t0 = dayStartMs;
  const rows: EventRow[] = [];
  const pm = new Map(prev.map((o) => [o.noradId, o])), cm = new Map(cur.map((o) => [o.noradId, o]));

  // appeared: in today's catalog, not in yesterday's
  const appClass: Record<string, number> = {};
  for (const o of cur) {
    if (pm.has(o.noradId)) continue;
    const seen = opts.firstSeen?.(o.noradId);
    const launch = o.launchDate ? Date.parse(o.launchDate) : NaN;
    const cls = Number.isFinite(launch) && t0 - launch < 31 * DAY_MS ? 'new_launch' : seen && seen < day ? 'returned' : 'newly_cataloged';
    appClass[cls] = (appClass[cls] ?? 0) + 1;
    rows.push({ kind: 'object.appeared', subjects: [o.noradId], tStart: epochMsOf(o.omm), tEnd: epochMsOf(o.omm), payload: { cls, reg: o.regime, perigee: o.perigee, apogee: o.apogee, launch: o.launchDate ?? undefined, name: o.name } });
  }
  const nApp = rows.length;

  // disappeared: in yesterday's catalog, not in today's
  const disClass: Record<string, number> = {};
  for (const o of prev) {
    if (cm.has(o.noradId)) continue;
    const ep = epochMsOf(o.omm);
    const ageDays = (t0 - ep) / DAY_MS;
    const p = makeProp(o.omm);
    let altKm: number | null = null;
    const pos = p ? posAt(p, t0) : null;
    if (pos) altKm = geodeticLatAltFromEr({ x: pos[0] / ER_KM, y: pos[1] / ER_KM, z: pos[2] / ER_KM }).altKm;
    const perigee = o.perigee ?? NaN;
    // Elements alone cannot say "decayed" vs "aged out of the 30-day window": an object that stopped being tracked 30 days ago
    // looks the same either way. So: a low last perigee / low propagated height is a decay signature (checked FIRST), otherwise
    // stale if the last elements are about 30 days old, otherwise unexplained.
    const cls = altKm === null || altKm < 140 || perigee < 250 ? 'decay_likely' : perigee < 350 && ageDays >= 28 ? 'ambiguous_low' : ageDays >= 28 ? 'stale_window' : 'unexplained';
    disClass[cls] = (disClass[cls] ?? 0) + 1;
    rows.push({ kind: 'object.disappeared', subjects: [o.noradId], tStart: t0, tEnd: t0, payload: {
      cls, reg: o.regime, ageDays: +ageDays.toFixed(2), perigee: o.perigee, apogee: o.apogee,
      bstar: Number(o.omm.BSTAR), mmdot: Number(o.omm.MEAN_MOTION_DOT), altKm: altKm === null ? null : +altKm.toFixed(1), lastEpoch: o.omm.EPOCH, name: o.name } });
  }
  const nDis = rows.length - nApp;

  // orbit change: the new element set differs from the old one propagated to its epoch by more than the thresholds
  const jm = jumpMetrics(prev, cur);
  const jumpDpos = opts.jumpDposKm ?? JUMP_DPOS_KM, jumpDa = opts.jumpDaKm ?? JUMP_DA_KM;
  let nJump = 0;
  const jumpDir: Record<string, number> = {};
  for (const m of jm.metrics) {
    if (!(m.dposKm > jumpDpos && Math.abs(m.daKm) > jumpDa && Math.abs(m.residKm) > jumpDa)) continue;
    nJump++;
    const dir = m.daKm > 0 ? 'raise' : 'lower';
    jumpDir[dir] = (jumpDir[dir] ?? 0) + 1;
    rows.push({ kind: 'elements.jump', subjects: [m.norad], tStart: m.prevEpochMs, tEnd: m.newEpochMs, payload: {
      dpos: +m.dposKm.toFixed(2), da: +m.daKm.toFixed(3), resid: +m.residKm.toFixed(3), dinc: +m.dIncDeg.toFixed(4), along: +m.dAlong.toFixed(2), gap: +m.gapDays.toFixed(2), dir, reg: m.regime, name: m.name } });
  }
  return { rows, stats: { appeared: nApp, disappeared: nDis, jumps: nJump, changedElsets: jm.metrics.length, jumpFailed: jm.failed, appClass, disClass, jumpDir } };
}
