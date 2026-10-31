// ============================================================
// Migration 0002 — encounter screening results (src/ssa/). Plain Postgres 16: no TimescaleDB, no PostGIS.
//
//   ssa_run             one row per nightly screening run (unique per batch_time: the idempotency key)
//   conjunction         one row per predicted encounter, followed across runs (matched by pair and TCA within 60 s)
//   conjunction_update  the history of an encounter: its numbers as seen by each run that re-predicted it
//   ssa_event           derived events (kind, day, subjects, interval, payload); the table only, derivation is a later step
//
// Shaped as FABRIC situations (a "close" with Pc) and events so they can fold into fabric_log later without a rewrite.
// ============================================================

export const sql = `
CREATE TABLE IF NOT EXISTS ssa_run (
  id             BIGSERIAL        PRIMARY KEY,
  batch_time     TIMESTAMPTZ      NOT NULL UNIQUE,
  element_cutoff TIMESTAMPTZ,
  objects        INTEGER          NOT NULL DEFAULT 0,
  encounters     INTEGER          NOT NULL DEFAULT 0,
  duration_s     REAL,
  code_version   TEXT,
  created_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conjunction (
  id           BIGSERIAL          PRIMARY KEY,
  norad_a      INTEGER            NOT NULL,
  norad_b      INTEGER            NOT NULL,
  tca          TIMESTAMPTZ        NOT NULL,
  miss_km      DOUBLE PRECISION   NOT NULL,
  vrel_kms     DOUBLE PRECISION   NOT NULL,
  ric_km       DOUBLE PRECISION[3],
  volume       TEXT,
  pc           DOUBLE PRECISION,
  pc_max       DOUBLE PRECISION,
  hbr_km       DOUBLE PRECISION,
  manoeuvrable BOOLEAN            NOT NULL DEFAULT false,
  label        TEXT,
  first_run    BIGINT             NOT NULL REFERENCES ssa_run (id),
  last_run     BIGINT             NOT NULL REFERENCES ssa_run (id),
  n_updates    INTEGER            NOT NULL DEFAULT 1,
  CONSTRAINT conjunction_pair_order CHECK (norad_a < norad_b)
);
CREATE INDEX IF NOT EXISTS conjunction_a_tca_idx ON conjunction (norad_a, tca);
CREATE INDEX IF NOT EXISTS conjunction_b_tca_idx ON conjunction (norad_b, tca);
CREATE INDEX IF NOT EXISTS conjunction_tca_idx   ON conjunction (tca);
CREATE INDEX IF NOT EXISTS conjunction_last_run_idx ON conjunction (last_run);

CREATE TABLE IF NOT EXISTS conjunction_update (
  conjunction_id BIGINT           NOT NULL REFERENCES conjunction (id) ON DELETE CASCADE,
  run_id         BIGINT           NOT NULL REFERENCES ssa_run (id),
  tca            TIMESTAMPTZ      NOT NULL,
  miss_km        DOUBLE PRECISION NOT NULL,
  pc             DOUBLE PRECISION,
  pc_max         DOUBLE PRECISION,
  ric_km         DOUBLE PRECISION[3],
  PRIMARY KEY (conjunction_id, run_id)
);
CREATE INDEX IF NOT EXISTS conjunction_update_run_idx ON conjunction_update (run_id);

CREATE TABLE IF NOT EXISTS ssa_event (
  id       BIGSERIAL   PRIMARY KEY,
  day      DATE        NOT NULL,
  kind     TEXT        NOT NULL,
  subjects INTEGER[]   NOT NULL DEFAULT '{}',
  t_start  TIMESTAMPTZ,
  t_end    TIMESTAMPTZ,
  payload  JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ssa_event_kind_day_idx ON ssa_event (kind, day);
CREATE INDEX IF NOT EXISTS ssa_event_subjects_idx ON ssa_event USING GIN (subjects);
CREATE INDEX IF NOT EXISTS ssa_event_t_start_idx  ON ssa_event (t_start);
`;

export const name = '0002_ssa';
