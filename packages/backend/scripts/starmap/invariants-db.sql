-- SPIKE — not production. Orbit-invariant sieve index experiments (local docker TimescaleDB only).
-- starmap.orbit_invariant       : real catalog (32.6k live + 32.1k past day 2026-07-15)
-- starmap.orbit_invariant_hist  : SYNTHETIC ~5M rows (150 daily snapshots x real objects, jittered). NOT REAL DATA.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS starmap;
DROP TABLE IF EXISTS starmap.orbit_invariant, starmap.orbit_invariant_hist, starmap.orbit_invariant_hist_ht;
CREATE TABLE starmap.orbit_invariant (
  norad_id int, epoch timestamptz, perigee_km float8, apogee_km float8, incl_deg float8,
  raan_deg float8, ecc float8, a_km float8,
  alt numrange GENERATED ALWAYS AS (numrange(perigee_km::numeric, apogee_km::numeric, '[]')) STORED);
CREATE TABLE starmap.orbit_invariant_hist (LIKE starmap.orbit_invariant INCLUDING GENERATED);
COMMENT ON TABLE starmap.orbit_invariant_hist IS 'SYNTHETIC: jittered copies of real catalog, one snapshot per day';
