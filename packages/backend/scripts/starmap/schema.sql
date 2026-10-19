-- SPIKE — not production. Star-map index table (local TimescaleDB only).
--
-- Design in plain words:
--   One row = one object inside one box during one slice of time (a "run").
--   "Box" = a SpaceCell (HEALPix direction x log-radius shell) in the TEME star frame,
--   so a box never moves; the object moves through boxes.
--   "bucket" = the start of the time slice (30 min by default) the run lies in; runs are
--   split at bucket edges, so every row sits in exactly one bucket. The bucket is the
--   hypertable time column, so a time-window question touches only the chunks it needs.
--   "cell" is stored ORDER-18-ALIGNED (key * 8^(18-order)). So a box of ANY coarser order
--   is just a range  lo <= cell < hi  (see keyRangeAtMaxOrder in orbital-core), and one
--   btree on (cell, bucket) answers questions at every order.
--   "ord" is the order the row was built at (all rows of one build share it).
--   t_in/t_out = when the object entered/left the box (to ~1 s). elset_epoch = epoch of the
--   element set that produced the run, so a later elset update can supersede old rows.

CREATE SCHEMA IF NOT EXISTS starmap;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS starmap.track_run (
  bucket      timestamptz NOT NULL,
  cell        int8        NOT NULL,
  ord         smallint    NOT NULL,
  norad_id    int         NOT NULL,
  t_in        timestamptz NOT NULL,
  t_out       timestamptz NOT NULL,
  elset_epoch timestamptz NOT NULL,
  frame       text        NOT NULL DEFAULT 'TEME'
);

SELECT create_hypertable('starmap.track_run', 'bucket',
  chunk_time_interval => INTERVAL '1 day', create_default_indexes => false, if_not_exists => true);

CREATE INDEX IF NOT EXISTS track_run_cell_bucket ON starmap.track_run (cell, bucket);
CREATE INDEX IF NOT EXISTS track_run_norad_tin   ON starmap.track_run (norad_id, t_in);
-- Q2 filters on bucket (+ t_in/t_out) with no cell predicate: this lets it skip a scan of the chunk.
CREATE INDEX IF NOT EXISTS track_run_bucket_tin  ON starmap.track_run (bucket, t_in);

-- Compression (apply once, then compress finished day-chunks). segmentby=bucket is what makes Q2/Q3 fast:
-- a bucket predicate then skips whole segments. The (bucket, t_in) btree above only serves UNCOMPRESSED chunks.
ALTER TABLE starmap.track_run SET (timescaledb.compress, timescaledb.compress_segmentby = 'bucket', timescaledb.compress_orderby = 'cell, t_in');
-- SELECT compress_chunk(c) FROM show_chunks('starmap.track_run') c;   -- or decompress_chunk + compress_chunk to re-apply settings
