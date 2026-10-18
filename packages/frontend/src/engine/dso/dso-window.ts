import type { DsoSnapshot } from '@orbitwatch/contracts';

/** Same grace the DSO worker allows after a snapshot's last sample (workers/dso.worker.ts). */
export const DSO_ACTIVE_GRACE_MS = 600_000;
const SLACK_MS = 60_000;

/**
 * True when at least one DSO's ephemeris window covers `nowMs`. Outside every window
 * nothing can be drawn, so the layer stops asking the worker for positions.
 */
export function anyDsoActiveAt(
  snapshots: Record<string, Pick<DsoSnapshot, 'validFrom' | 'validTo'>>,
  nowMs: number,
): boolean {
  for (const s of Object.values(snapshots)) {
    const from = Date.parse(s.validFrom);
    const to = Date.parse(s.validTo);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (nowMs >= from - SLACK_MS && nowMs <= to + DSO_ACTIVE_GRACE_MS + SLACK_MS) return true;
  }
  return false;
}
