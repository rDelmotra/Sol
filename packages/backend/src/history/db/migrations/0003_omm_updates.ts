// ============================================================
// Migration 0003 — every element-set update, not one per object per day.
//
// omm_daily keeps one row per (object, day) (the later epoch wins), which is what history serving needs. The encounter screener
// needs the latest set per object AS OF a batch time (causal replay) and uncertainty refits need successive sets, so every
// published set is kept here, keyed by (norad_id, epoch). The jsonb is the OMM object (EPOCH, MEAN_MOTION, ...).
// ============================================================

export const sql = `
CREATE TABLE IF NOT EXISTS omm_updates (
  norad_id    INTEGER     NOT NULL,
  epoch       TIMESTAMPTZ NOT NULL,
  omm         JSONB       NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT omm_updates_norad_epoch_uniq UNIQUE (norad_id, epoch)
);
CREATE INDEX IF NOT EXISTS omm_updates_epoch_idx ON omm_updates (epoch);
`;

export const name = '0003_omm_updates';
