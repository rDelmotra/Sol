// ============================================================
// Migration 0005 — per-day completion record of the nightly SSA job's parts.
//
// ssa_day_status(day, part): `part` is 'changes' (change detection, ssa_event) or 'coverage' (star-map coverage files). A row with
// done_at set means that part finished for that UTC day; the writer sets it in the same transaction (changes) or right after the
// atomic file rename (coverage) as its output. A row with done_at NULL is a failed attempt: stats = {attempts, lastAttemptAt, error},
// used by the catch-up loop to back off instead of retrying a broken day forever.
// ============================================================

export const sql = `
CREATE TABLE IF NOT EXISTS ssa_day_status (
  day     DATE        NOT NULL,
  part    TEXT        NOT NULL CHECK (part IN ('changes', 'coverage')),
  done_at TIMESTAMPTZ NULL,
  stats   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (day, part)
);
`;

export const name = '0005_ssa_day_status';
